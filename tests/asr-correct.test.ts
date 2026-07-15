/**
 * ASR hotword correction (src/lib/asr-correct.ts). Locks down that close mis-hearings of pharma
 * proper nouns snap to the canonical spelling, that a better Web Speech alternative is picked over
 * a worse top guess, and — critically — that ordinary words are NOT snapped onto a drug name.
 */

import { describe, expect, it } from "vitest";
import { correctTranscript, correctBestAlternative, correctionTerms } from "@lib/asr-correct";

const TERMS = ["Milvexian", "LIBREXIA", "Factor XIa", "apixaban"];

describe("correctTranscript", () => {
  it("snaps a close mis-spelling to the canonical drug name", () => {
    expect(correctTranscript("how does malvaxian work", TERMS).text).toBe("how does Milvexian work");
  });

  it("fixes casing on an exact-but-lowercase match", () => {
    expect(correctTranscript("tell me about librexia", TERMS).text).toBe("tell me about LIBREXIA");
  });

  it("recovers a single name heard as two words", () => {
    expect(correctTranscript("what is mil vexian", TERMS).text).toBe("what is Milvexian");
  });

  it("corrects a multi-word term (Factor XIa heard as 'factor 11a')", () => {
    expect(correctTranscript("is it a factor 11a inhibitor", TERMS).text).toBe("is it a Factor XIa inhibitor");
  });

  it("reports what it corrected", () => {
    const r = correctTranscript("how does malvaxian work", TERMS);
    expect(r.corrections).toEqual([["malvaxian", "Milvexian"]]);
  });

  it("does NOT snap ordinary words onto a drug name (no false positives)", () => {
    for (const q of ["what is the development status", "how is it tolerated", "can I use it off label"]) {
      expect(correctTranscript(q, TERMS).text).toBe(q);
    }
  });

  it("no-ops on empty text or empty terms", () => {
    expect(correctTranscript("", TERMS).text).toBe("");
    expect(correctTranscript("how does malvaxian work", []).text).toBe("how does malvaxian work");
  });
});

describe("correctTranscript — phonetic (vowel-swap) mis-hearings", () => {
  const TERMS2 = ["Milvexian", "LIBREXIA", "Factor XIa", "atrial fibrillation", "apixaban"];
  it.each([
    ["how does milvaxion work", "how does Milvexian work"],
    ["tell me about libraxia", "tell me about LIBREXIA"],
    ["is it a factor exia inhibitor", "is it a Factor XIa inhibitor"],
    ["does it help atrial fibrilation", "does it help atrial fibrillation"], // dropped an 'l'
  ])("snaps %j → %j", (input, expected) => {
    expect(correctTranscript(input, TERMS2).text).toBe(expected);
  });

  it("still does not snap unrelated 'm' / 'a' words onto a drug name", () => {
    for (const q of ["what medication schedule", "any adverse effects", "how is it administered"]) {
      expect(correctTranscript(q, TERMS2).text).toBe(q);
    }
  });
});

describe("correctionTerms — trial-name siblings are STT-only, never text-correction terms", () => {
  // The full hotword set the Milvexian brand ships (trial names included, for Tavus STT bias).
  const HOTWORDS = ["Milvexian", "LIBREXIA", "LIBREXIA AF", "LIBREXIA ACS", "LIBREXIA STROKE", "Factor XIa", "TIA", "apixaban"];
  const TERMS = correctionTerms(HOTWORDS);

  it("drops the ambiguous LIBREXIA-<trial> combos but keeps distinct multi-word terms", () => {
    expect(TERMS).not.toContain("LIBREXIA AF");
    expect(TERMS).not.toContain("LIBREXIA STROKE");
    expect(TERMS).toContain("LIBREXIA");
    expect(TERMS).toContain("Factor XIa"); // "Factor" is not itself a standalone term → kept
  });

  it.each([
    // The prefix is fixed via the single "LIBREXIA"; the distinct trial word is left exactly as heard,
    // so the corrector NEVER snaps "AF" onto the wrong trial ("ACS"/"STROKE").
    ["what is libraxia AF", "what is LIBREXIA AF"],
    ["what is the libraxia stroke", "what is the LIBREXIA stroke"],
    ["tell me about lebrixia", "tell me about LIBREXIA"],
    ["how does milvaxian work", "how does Milvexian work"],
  ])("snaps %j → %j (no wrong-trial disambiguation)", (input, expected) => {
    expect(correctTranscript(input, TERMS).text).toBe(expected);
  });

  it("does not invent a drug name from an unrelated 'l' word", () => {
    expect(correctTranscript("what is the label", TERMS).text).toBe("what is the label");
  });
});

describe("correctBestAlternative", () => {
  it("picks the alternative that recovers the most drug names, then corrects it", () => {
    const r = correctBestAlternative(["how does my vaccine work", "how does milvexian work"], TERMS);
    expect(r.text).toBe("how does Milvexian work");
    expect(r.chosenIndex).toBe(1);
  });

  it("falls back to the top alternative when none is clearly better", () => {
    const r = correctBestAlternative(["what is the development status"], TERMS);
    expect(r.text).toBe("what is the development status");
    expect(r.chosenIndex).toBe(0);
  });

  it("handles no alternatives", () => {
    expect(correctBestAlternative([], TERMS)).toEqual({ text: "", corrections: [], chosenIndex: -1 });
  });
});
