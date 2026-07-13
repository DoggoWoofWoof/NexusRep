/**
 * Setup autofill from uploaded documents (Build → upload once instead of
 * answering every setup question by hand). Covers: LLM extraction with strict
 * JSON (including fenced output), fills-only-blanks, deterministic offline
 * fallback, and fail-safe on malformed LLM output.
 */
import { describe, expect, it } from "vitest";
import { inferSetupAnswersFromDocument } from "../src/modules/setupAssistant";

const DOC = `Cardiozan overview. Cardiozan is an investigational oral Factor XIa inhibitor
from Helix Therapeutics being studied for stroke prevention in atrial fibrillation.
The VANTAGE-AF Phase 3 study is evaluating Cardiozan against standard of care.
Cardiozan selectively inhibits Factor XIa in the intrinsic coagulation pathway.`;

const LLM_JSON = JSON.stringify({
  brand: "Cardiozan",
  indication: "stroke prevention in atrial fibrillation",
  therapeutic_area: "cardiology",
  sponsor: "Helix Therapeutics",
  tagline: "An investigational oral Factor XIa inhibitor",
  talking_points: "mechanism, VANTAGE-AF program, safety profile",
  hotwords: "Cardiozan, VANTAGE-AF, Factor XIa",
  try_questions: "How does it work?; What is VANTAGE-AF studying?",
});

describe("inferSetupAnswersFromDocument", () => {
  it("fills blank fields from LLM extraction and never overwrites existing answers", async () => {
    const existing = { brand: "Milvexian", indication: "" }; // brand already answered by the user
    const out = await inferSetupAnswersFromDocument(DOC, existing, async () => LLM_JSON);
    expect(out.filled.brand).toBeUndefined(); // user's answer wins
    expect(out.filled.indication).toBe("stroke prevention in atrial fibrillation");
    expect(out.filled.sponsor).toBe("Helix Therapeutics");
    expect(out.filled.hotwords).toContain("VANTAGE-AF");
  });

  it("accepts markdown-fenced JSON from the LLM", async () => {
    const out = await inferSetupAnswersFromDocument(DOC, {}, async () => "```json\n" + LLM_JSON + "\n```");
    expect(out.filled.brand).toBe("Cardiozan");
    expect(out.filled.therapeutic_area).toBe("cardiology");
  });

  it("falls back to deterministic brand detection when no LLM is available", async () => {
    const out = await inferSetupAnswersFromDocument(DOC, {});
    expect(out.filled.brand).toBe("Cardiozan"); // most repeated capitalized token
    expect(out.skipped).toContain("sponsor"); // deterministic path only fills the basics
  });

  it("fails safe on malformed LLM output (still deterministic brand, nothing invented)", async () => {
    const out = await inferSetupAnswersFromDocument(DOC, {}, async () => "Sure! Here are the fields you asked for.");
    expect(out.filled.brand).toBe("Cardiozan");
    expect(out.filled.tagline).toBeUndefined();
  });

  it("returns nothing when every inferable field is already answered", async () => {
    const existing = Object.fromEntries(
      ["brand", "indication", "therapeutic_area", "sponsor", "tagline", "talking_points", "hotwords", "try_questions", "target_specialties", "target_conditions", "msl_contact", "ae_routing"].map((k) => [k, "set"]),
    );
    let llmCalled = false;
    const out = await inferSetupAnswersFromDocument(DOC, existing, async () => ((llmCalled = true), LLM_JSON));
    expect(out.filled).toEqual({});
    expect(llmCalled).toBe(false); // no wasted LLM call when there's nothing to fill
  });

  it("ignores empty documents", async () => {
    const out = await inferSetupAnswersFromDocument("   ", {}, async () => LLM_JSON);
    expect(out.filled).toEqual({});
  });
});
