/**
 * Fuzzy / false-positive guard for the doctor-transcript regressions the demo hit:
 *   1. The AI-representative disclosure preamble ("I'm an AI representative, I want to note …")
 *      must NEVER appear in an answer body — no matter how the HCP phrases the question, and even
 *      on the first turn. It belongs to the greeting only.
 *   2. ISI delivers exactly ONCE per session.
 *   3. A slide is only "promised" when one is actually attached: if an approved answer references
 *      a slide / "on your screen", it MUST carry a detailAidSlideId (so the deck really switches).
 *   4. No fabricated dose ever leaks into an answer.
 *
 * Runs against the deterministic builder ({ composer: null }) so it is stable and key-independent
 * — this is the path that also backstops the LLM composer when a model times out or is absent.
 * A wide spread of paraphrases stands in for fuzzing: if any one of them trips an invariant, the
 * regression is caught.
 */

import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";

// The robotic preamble, in the shapes the transcripts showed it. None may appear in a body.
const DISCLOSURE_PREAMBLE =
  /\b(?:just to note,?\s*)?(?:as\s+)?i(?:'m| am)\s+an?\s+ai(?:\s+pharmaceutical)?\s+representative\b|\bi\s+(?:want to|should)\s+note\b/i;
const FABRICATED_DOSE = /\b\d+(?:\.\d+)?\s?(?:mg|milligrams?|mcg|g)\b/i;
const MENTIONS_SLIDE = /\bslide\b|on (?:your )?screen|pulled up|take a look|shown on/i;

// A broad spread of HCP phrasings — mechanism, program, status, indications, follow-ups, and
// casual re-asks — the kind of variation a real conversation produces.
const QUESTIONS = [
  "How does Milvexian work?",
  "how does malvaxian work",
  "how does librexia work?",
  "What is LIBREXIA?",
  "tell me about the program",
  "what's it used for?",
  "what indications are being studied",
  "is it approved?",
  "what's the development status",
  "remind me how it works again",
  "what is milvexian",
  "walk me through the phase 3 program",
];

describe("HCP transcript cadence — fuzzy invariants (deterministic path)", () => {
  it("never emits the AI-representative preamble in any answer body, across many phrasings", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    for (const text of QUESTIONS) {
      const out = (await c.conversation.turn(
        { sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text },
        { composer: null },
      )).output;
      const body = out.responseText.split("\n\nImportant Safety Information:")[0] ?? out.responseText;
      expect(body, `preamble leaked for "${text}": ${body}`).not.toMatch(DISCLOSURE_PREAMBLE);
      expect(out.responseText, `fabricated dose for "${text}"`).not.toMatch(FABRICATED_DOSE);
    }
  });

  it("delivers ISI exactly once across a long, varied session", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    let isiCount = 0;
    for (const text of QUESTIONS) {
      const out = (await c.conversation.turn(
        { sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text },
        { composer: null },
      )).output;
      if (out.responseText.includes("Important Safety Information:")) isiCount++;
    }
    expect(isiCount).toBe(1);
  });

  it("only references a slide when one is actually attached (no dangling 'on screen' promise)", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    for (const text of QUESTIONS) {
      const out = (await c.conversation.turn(
        { sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text },
        { composer: null },
      )).output;
      const body = out.responseText.split("\n\nImportant Safety Information:")[0] ?? out.responseText;
      if (MENTIONS_SLIDE.test(body)) {
        expect(out.detailAidSlideId, `"${text}" mentions a slide but has no detailAidSlideId — the deck can't switch`).toBeTruthy();
      }
    }
  });

  it("keeps abbreviations intact — 'U.S. FDA' is never mangled to 'S. FDA' by sentence splitting", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    // A status question surfaces the "received U.S. FDA Fast Track designation" approved block.
    for (const text of ["what's the development status", "is it approved?", "tell me about the fast track designation"]) {
      const out = (await c.conversation.turn(
        { sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text },
        { composer: null },
      )).output.responseText;
      if (/fast track/i.test(out)) {
        // The sentence splitter must not drop the "U." and leave a dangling "S. FDA".
        expect(out, `"${text}" mangled the abbreviation: ${out}`).not.toMatch(/(^|\s)S\.\s*FDA\b/);
        expect(out).toMatch(/U\.S\.\s*FDA/);
      }
    }
  });
});
