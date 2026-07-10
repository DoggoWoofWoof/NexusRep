/**
 * ISI + disclosure cadence — the doctor-transcript regression: ISI must deliver exactly
 * once per session (a safety question delivers it verbatim via the Medical Information
 * route), and a composer-embedded ISI copy is stripped deterministically.
 */

import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";
import { stripEmbeddedIsi } from "@modules/compliance";

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
