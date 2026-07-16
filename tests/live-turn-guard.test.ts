import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetLiveTurnGuardForTests,
  beginLiveTurn,
  failLiveTurn,
  finishLiveTurn,
  isSameLiveTurnText,
} from "@lib/live-turn-guard";

describe("live Tavus turn guard", () => {
  beforeEach(() => __resetLiveTurnGuardForTests());

  it("treats exact and same-prefix Tavus finals as the same open-mic turn", () => {
    expect(isSameLiveTurnText("How does Milvexian work?", "How does Milvexian work")).toBe(true);
    expect(isSameLiveTurnText("How does Milvexian", "How does Milvexian work?")).toBe(true);
    expect(isSameLiveTurnText("How does Milvexian work?", "What is the LIBREXIA program?")).toBe(false);
    expect(isSameLiveTurnText("How does Milvexian work?", "How does Milvexian work and what is LIBREXIA?")).toBe(false);
  });

  it("drops duplicate in-flight and recent turns so Tavus cannot queue multiple answers", () => {
    const first = beginLiveTurn("s1", "How does Milvexian work?", 1000);
    expect(first.action).toBe("accept");
    expect(beginLiveTurn("s1", "How does Milvexian work", 1500)).toEqual({
      action: "drop",
      reason: "duplicate_in_flight",
    });
    if (first.action === "accept") finishLiveTurn(first.handle, 2500);
    expect(beginLiveTurn("s1", "How does Milvexian work?", 6_000)).toEqual({
      action: "drop",
      reason: "duplicate_recent",
    });
  });

  it("allows the doctor to ask the same question again after the immediate re-emit window", () => {
    const first = beginLiveTurn("s1", "How does Milvexian work?", 1000);
    expect(first.action).toBe("accept");
    if (first.action === "accept") finishLiveTurn(first.handle, 2500);
    expect(beginLiveTurn("s1", "How does Milvexian work?", 9_000).action).toBe("accept");
  });

  it("allows a distinct barge-in question while a prior answer is still generating", () => {
    const first = beginLiveTurn("s1", "How does Milvexian work?", 1000);
    expect(first.action).toBe("accept");
    const second = beginLiveTurn("s1", "What is the LIBREXIA program?", 1300);
    expect(second.action).toBe("accept");
    if (first.action === "accept") expect(finishLiveTurn(first.handle, 2000).status).toBe("current");
    if (second.action === "accept") expect(finishLiveTurn(second.handle, 2500).status).toBe("current");
  });

  it("clears an active turn on failure so retry is possible", () => {
    const first = beginLiveTurn("s1", "How does Milvexian work?", 1000);
    expect(first.action).toBe("accept");
    if (first.action === "accept") failLiveTurn(first.handle);
    expect(beginLiveTurn("s1", "How does Milvexian work?", 1200).action).toBe("accept");
  });
});
