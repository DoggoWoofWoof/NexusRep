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
  });

  it("leaves an exact name and ordinary words untouched (no false positives)", () => {
    expect(canonicalizeProductNames("Tell me about Milvexian")).toBe("Tell me about Milvexian");
    expect(canonicalizeProductNames("what is the clinical program studying")).toBe("what is the clinical program studying");
    expect(canonicalizeProductNames("I don't want to go through all this")).toBe("I don't want to go through all this");
  });

  it("a recovered name now routes to an approved answer, not the fallback", () => {
    const before = classify("novexian");
    expect(route(before)).toBe("fallback"); // bare garbled name → would have bounced
    const after = classify(canonicalizeProductNames("novexian"));
    expect(after.intent).toBe("product_info");
    expect(route(after)).toBe("approved_answer");
  });
});

describe("garbled product name is answered end-to-end", () => {
  it("the rep answers 'tell me about no vexian' instead of bouncing to a human", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const { output, session } = await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text: "Tell me about no vexian",
    });
    expect(output.route).toBe("approved_answer");
    expect(output.responseText).not.toContain("connect you with someone");
    // The logged HCP turn shows the corrected name, so the transcript is clean.
    const hcpTurn = session!.turns.find((t) => t.speaker === "hcp");
    expect(hcpTurn?.text).toContain("Milvexian");
  });
});
