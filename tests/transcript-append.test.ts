/**
 * Guards the doctor-transcript append rule (src/lib/transcript.ts) — the seam that dropped rep
 * captions in the live video demo. The regression to lock down: a follow-up like "how does it
 * work?" yields the SAME approved answer as an earlier turn, and the transcript must still show it.
 * Only a consecutive re-emit (Tavus streaming→final, or a typed ask echoed back) is suppressed.
 */

import { describe, expect, it } from "vitest";
import { appendTurn, type TranscriptMsg } from "@lib/transcript";

const rep = (text: string): TranscriptMsg => ({ role: "rep", text });
const hcp = (text: string): TranscriptMsg => ({ role: "hcp", text });
const MOA = "Milvexian is an investigational, orally administered Factor XIa inhibitor being studied as an anticoagulant.";

describe("appendTurn — doctor transcript", () => {
  it("KEEPS a repeated answer that follows a new HCP question (the dropped-caption bug)", () => {
    // Reproduces the exact demo sequence: MoA answer, then "how does it work?", then the same MoA text.
    let msgs: TranscriptMsg[] = [];
    msgs = appendTurn(msgs, "hcp", "How does Milvexian work?");
    msgs = appendTurn(msgs, "rep", MOA);
    msgs = appendTurn(msgs, "hcp", "How does it work?");
    msgs = appendTurn(msgs, "rep", MOA); // same text, legitimately a new turn — must NOT be dropped
    expect(msgs.filter((m) => m.role === "rep" && m.text === MOA)).toHaveLength(2);
    expect(msgs[msgs.length - 1]).toEqual(rep(MOA));
  });

  it("SUPPRESSES a consecutive re-emit of the same speaker's identical text", () => {
    let msgs = [hcp("How does it work?")];
    msgs = appendTurn(msgs, "rep", MOA);
    const after = appendTurn(msgs, "rep", MOA); // Tavus finalizing what it just streamed
    expect(after).toBe(msgs); // same reference → React setState no-op
    expect(after.filter((m) => m.role === "rep")).toHaveLength(1);
  });

  it("treats whitespace-only differences as the same text (re-emit), and trims", () => {
    let msgs = [rep("  hello   world ")];
    msgs = appendTurn(msgs, "rep", "hello world");
    expect(msgs).toHaveLength(1); // normalized-equal to the last rep turn
  });

  it("does not suppress when the previous identical text was a DIFFERENT speaker", () => {
    // A rep echoing the doctor's words verbatim is still its own turn.
    let msgs = [hcp("is it approved?")];
    msgs = appendTurn(msgs, "rep", "is it approved?");
    expect(msgs).toHaveLength(2);
  });

  it("ignores empty / whitespace-only text without mutating the array", () => {
    const msgs = [rep(MOA)];
    expect(appendTurn(msgs, "rep", "   ")).toBe(msgs);
    expect(appendTurn(msgs, "hcp", "")).toBe(msgs);
  });

  it("allows the same answer to recur across the session as long as it isn't back-to-back", () => {
    let msgs: TranscriptMsg[] = [];
    for (let i = 0; i < 3; i++) {
      msgs = appendTurn(msgs, "hcp", `ask ${i}`);
      msgs = appendTurn(msgs, "rep", MOA);
    }
    expect(msgs.filter((m) => m.role === "rep")).toHaveLength(3);
  });
});
