/**
 * ISI + disclosure cadence — the doctor-transcript regression: ISI must deliver exactly
 * once per session (a safety question delivers it verbatim via the Medical Information
 * route), and a composer-embedded ISI copy is stripped deterministically.
 */

import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";
import { stripEmbeddedIsi } from "@modules/compliance";
import type { GroundedComposer } from "@modules/content";

describe("ISI cadence in a doctor chat", () => {
  it("the exact transcript: safety Q delivers ISI verbatim once; later answers stay clean", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const ask = async (text: string) => (await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text,
    })).output;

    const isi = (await c.content.latestActiveSafetyStatement())!.text;
    const q1 = await ask("What safety information should I be aware of?");
    // The safety ask is answered with the APPROVED ISI verbatim + the MI handoff — not a bounce.
    expect(q1.route).toBe("medical_information");
    expect(q1.responseText).toContain(`Important Safety Information: ${isi}`);

    const rest = [
      await ask("What is the clinical program studying?"),
      await ask("What is Milvexian's development status?"),
      await ask("How does Milvexian work?"),
      await ask("What is the clinical program studying?"),
    ];
    // ISI was delivered in q1 — nothing after re-delivers it.
    for (const r of rest) expect(r.responseText).not.toContain("Important Safety Information");
  });

  it("without a safety question, ISI still delivers exactly once", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const ask = async (text: string) => (await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text,
    })).output.responseText;
    const answers = [
      await ask("What is the clinical program studying?"),
      await ask("What is Milvexian's development status?"),
      await ask("What is the clinical program studying?"),
    ];
    expect(answers.filter((t) => t.includes("Important Safety Information")).length).toBe(1);
  });

  it("does not repeat standalone not-approved wording in the answer body when ISI is appended", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const out = (await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text: "How does Milvexian work?",
    })).output.responseText;
    const body = out.split("\n\nImportant Safety Information:")[0] ?? out;
    expect(out).toContain("Important Safety Information:");
    expect(body).not.toMatch(/\b(?:not\s+(?:yet\s+)?approved|not\s+(?:yet\s+)?FDA[-\s]?approved)\b.*\b(?:FDA|regulatory authorit)/i);
    expect(out).not.toMatch(/\*\*|__/);
  });

  it("does not re-introduce itself after a greeting/disclosure has already been logged", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.audit.record(s.id, "response_output", {
      route: "greeting",
      text: "Hello, doctor. I'm an AI representative for Milvexian, an investigational compound from J&J.",
      sourceIds: [],
      greeting: true,
    });
    const out = (await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text: "What is LIBREXIA?",
    })).output.responseText;
    expect(out).not.toMatch(/\bAI representative\b/i);
  });

  it("strips a bad composer lead-in that tries to re-introduce the AI rep", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.audit.record(s.id, "response_output", {
      route: "greeting",
      text: "Hello, doctor. I'm an AI representative for Milvexian, an investigational compound from J&J.",
      sourceIds: [],
      greeting: true,
    });
    const badComposer: GroundedComposer = {
      name: "bad-test-composer",
      available: () => true,
      compose: async ({ blocks }) => ({
        // Keeps the "AI representative" lead-in (what this test strips) AND cues the slide, like a
        // real composed answer — so the deck switch still applies (switch is gated on a spoken cue).
        text: `I'm an AI representative, and I want to note that ${blocks[0]!.text} Take a look at the slide on your screen.`,
        latencyMs: 1,
      }),
    };
    const out = await c.orchestrator.handleTurn({
      sessionId: s.id,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text: "What is LIBREXIA?",
    }, { composer: badComposer });
    expect(out.responseText).not.toMatch(/\bAI representative\b/i);
    expect(out.responseText.toLowerCase()).toContain("librexia");
    expect(out.detailAidSlideId).toBe("slide_program");
  });
});

describe("stripEmbeddedIsi — deterministic backstop against composer-embedded ISI", () => {
  const isi = "Milvexian is an investigational compound not approved by the FDA; its safety and efficacy have not been established.";

  it("removes a headed embedded copy regardless of whitespace", () => {
    const body = `The program studies three indications.\n\nImportant Safety Information: Milvexian is an investigational   compound not approved by the FDA; its safety and efficacy have\nnot been established.`;
    const out = stripEmbeddedIsi(body, isi);
    expect(out).toBe("The program studies three indications.");
  });

  it("removes a bare (unheaded) embedded copy", () => {
    const out = stripEmbeddedIsi(`Answer body. ${isi}`, isi);
    expect(out).toBe("Answer body.");
  });

  it("no-ops when the ISI isn't embedded, or on empty ISI", () => {
    expect(stripEmbeddedIsi("Plain answer.", isi)).toBe("Plain answer.");
    expect(stripEmbeddedIsi("Plain answer.", "")).toBe("Plain answer.");
  });
});
