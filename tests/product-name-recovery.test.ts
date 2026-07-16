/**
 * Fuzzy product-name recovery: an ASR/typo near-miss of the product name still
 * classifies as a product question and retrieves the right content, instead of
 * bouncing to the human-handoff fallback. (Root-caused from a live voice call
 * where "Milvexian" was transcribed "no vexian".)
 */

import { describe, expect, it, beforeEach } from "vitest";
import { canonicalizeProductNames, configureClassifierLexicon, classify, route } from "@modules/compliance";
import { createContainer } from "@lib/container";

describe("canonicalizeProductNames", () => {
  beforeEach(() => configureClassifierLexicon(["milvexian", "librexia", "factor xia", "fxia", "apixaban"]));

  it("recovers the classic mistranscriptions of the product name", () => {
    expect(canonicalizeProductNames("Tell me about no vexian")).toBe("Tell me about Milvexian");
    expect(canonicalizeProductNames("what is novexian")).toBe("what is Milvexian");
    expect(canonicalizeProductNames("how does milvexin work")).toBe("how does Milvexian work");
    expect(canonicalizeProductNames("tell me about milbaxian")).toBe("tell me about Milvexian");
    expect(canonicalizeProductNames("how does malvaxian work")).toBe("how does Milvexian work");
    expect(canonicalizeProductNames("how does my vaccine work")).toBe("how does Milvexian work");
    expect(canonicalizeProductNames("how does the vaccine work")).toBe("how does Milvexian work");
    expect(canonicalizeProductNames("Vaccine work.")).toBe("Milvexian work.");
    expect(canonicalizeProductNames("vaccine mechanism")).toBe("Milvexian mechanism");
    expect(canonicalizeProductNames("What is BILL vaccine? I does Milvexian work?")).toBe("What is Milvexian? I does Milvexian work?");
    expect(canonicalizeProductNames("How does mylovaxia work?")).toBe("How does Milvexian work?");
    expect(canonicalizeProductNames("What is the liberation, bro?")).toBe("What is the LIBREXIA program?");
  });

  it("leaves an exact name and ordinary words untouched (no false positives)", () => {
    expect(canonicalizeProductNames("Tell me about Milvexian")).toBe("Tell me about Milvexian");
    expect(canonicalizeProductNames("Tell me about LIBREXIA AF")).toBe("Tell me about LIBREXIA AF");
    expect(canonicalizeProductNames("Tell me about LIBREXIA ACS")).toBe("Tell me about LIBREXIA ACS");
    expect(canonicalizeProductNames("what is the clinical program studying")).toBe("what is the clinical program studying");
    expect(canonicalizeProductNames("I don't want to go through all this")).toBe("I don't want to go through all this");
    expect(canonicalizeProductNames("vaccine safety in adults")).toBe("vaccine safety in adults");
  });

  it("canonicalizing a garbled name yields a confident product_info intent", () => {
    // A bare garbled name classifies as "other" (unrecognized)…
    expect(classify("novexian").intent).toBe("other");
    // …and canonicalization recovers it to a confident product question.
    const after = classify(canonicalizeProductNames("novexian"));
    expect(after.intent).toBe("product_info");
    // Either way the router now ATTEMPTS an approved answer (retrieval + grounding gate decide),
    // rather than reflexively bouncing an unclear query to the fallback.
    expect(route(classify("novexian"))).toBe("approved_answer");
    expect(route(after)).toBe("approved_answer");
  });
});

describe("garbled product name is answered end-to-end", () => {
  it("the rep answers near-miss product names instead of bouncing to a human", async () => {
    const c = await createContainer();
    for (const text of ["Tell me about no vexian", "Yeah, can you tell me about Milbaxian?", "How does Malvaxian work?", "How does my vaccine work?", "Vaccine work.", "How does mylovaxia work?"]) {
      const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
      const { output, session } = await c.conversation.turn({
        sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
        indication: c.demo.indication, market: c.demo.market,
        investigational: c.demo.investigational, text,
      });
      expect(output.route, text).toBe("approved_answer");
      expect(output.responseText, text).not.toContain("connect you with someone");
      // The logged HCP turn shows the corrected name, so the transcript is clean.
      const hcpTurn = session!.turns.find((t) => t.speaker === "hcp");
      expect(hcpTurn?.text, text).toContain("Milvexian");
    }
  });

  it("routes a garbled 'BILL vaccine ... how does it work' turn to mechanism, not the company/title block", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const { output, session } = await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational,
      text: "What is BILL vaccine? I does Milvexian work?",
    });
    expect(session!.turns.find((t) => t.speaker === "hcp")?.text).toContain("Milvexian");
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_moa");
    expect(output.responseText.toLowerCase()).toMatch(/factor xia|coagulation|mechanism/);
    expect(output.responseText.toLowerCase()).not.toMatch(/developed by johnson|collaboration with bristol myers/);
  }, 60_000);

  it("answers a Tavus-split LIBREXIA program mishearing from the program slide", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const { output, session } = await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational,
      text: "What is the liberation, bro?",
    });
    expect(session!.turns.find((t) => t.speaker === "hcp")?.text).toContain("LIBREXIA program");
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_program");
    expect(output.responseText.toLowerCase()).toMatch(/librexia|phase 3|program/);
  }, 60_000);

  it("does not turn unrelated ASR garbage into a confident product answer", async () => {
    const c = await createContainer();
    for (const text of ["What is the limbic syndrome?", "Got a look.", "I was relaxing work."]) {
      const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
      const { output } = await c.conversation.turn({
        sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
        indication: c.demo.indication, market: c.demo.market,
        investigational: c.demo.investigational, text,
      });
      expect(output.route, text).toBe("fallback");
      expect(output.sourceIds, text).toEqual([]);
      expect(output.responseText, text).toMatch(/misheard|approved information|connect/i);
    }
  });
});
