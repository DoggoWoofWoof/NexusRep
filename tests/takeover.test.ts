/**
 * Human takeover mechanic — the "can we?" the user asked to verify: at any point a human rep can take
 * over a live conversation; from then, HCP messages are NOT answered by the AI (held for the human) but
 * ARE logged for context/memory; the human's replies go through; and on hand-back the AI resumes with
 * the full transcript — including what the human said — as its context. Drives the real container, no UI.
 */

import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";

type Ctr = Awaited<ReturnType<typeof createContainer>>;

function turnCtx(c: Ctr, text: string, sessionId: Ctr["demo"]["sessionId"]) {
  return { sessionId, hcpId: c.demo.hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text };
}
const repCount = (s: { turns: { speaker: string }[] } | null | undefined) => (s?.turns ?? []).filter((t) => t.speaker === "rep").length;
const hcpCount = (s: { turns: { speaker: string }[] } | null | undefined) => (s?.turns ?? []).filter((t) => t.speaker === "hcp").length;

describe("human takeover — AI stops, human speaks, context preserved, hand back to AI", () => {
  it("holds HCP turns for the human while taken over, then the AI resumes with the transcript as context", async () => {
    const c = await createContainer();
    const sid = (await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId })).id;

    // 1) AI mode: the rep answers, adding an AI rep turn.
    const t1 = await c.conversation.turn(turnCtx(c, "What is Milvexian?", sid));
    expect(t1.held).toBeFalsy();
    expect(repCount(t1.session)).toBe(1);
    expect(hcpCount(t1.session)).toBe(1);

    // 2) A human takes over.
    await c.conversation.takeOver(sid, "swastik");

    // 3) An HCP turn during takeover is HELD — logged (context), but NO AI reply is generated.
    const t2 = await c.conversation.turn(turnCtx(c, "Can a real person help me with the dosing?", sid));
    expect(t2.held).toBe(true);
    expect(t2.output.responseText).toBe("");
    expect(repCount(t2.session)).toBe(1); // no new AI rep turn
    expect(hcpCount(t2.session)).toBe(2); // but the HCP turn IS in the transcript

    // 4) The human sends a reply — logged, marked human-authored, delivered like a rep turn.
    const afterHuman = await c.conversation.humanReply(sid, { text: "This is Alex, a human representative — I'll help you directly.", by: "swastik" });
    const humanTurn = (afterHuman?.turns ?? []).find((t) => t.human);
    expect(humanTurn?.speaker).toBe("rep");
    expect(humanTurn?.text).toContain("human representative");
    expect(repCount(afterHuman)).toBe(2); // the human reply added a rep turn

    // 5) Hand back → the AI answers again, and it can SEE the human turn in the transcript (context/memory).
    await c.conversation.handBack(sid);
    const t3 = await c.conversation.turn(turnCtx(c, "And what is the LIBREXIA program?", sid));
    expect(t3.held).toBeFalsy();
    expect(repCount(t3.session)).toBe(3); // AI resumed, adding another rep turn
    expect(hcpCount(t3.session)).toBe(3);
    expect((t3.session?.turns ?? []).some((t) => t.human)).toBe(true); // the human's message survives for the AI's context
  });
});
