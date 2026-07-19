import { describe, it, expect } from "vitest";
import { UsageLedger, estimateCostUsd, priceKey, vendorForModel } from "@modules/usage";
import { dumpActivity, loadActivity, recordActivity, clearActivity, queryActivity } from "@modules/activity";

describe("usage pricing", () => {
  it("normalizes model strings to a price key (TTS matched before chat)", () => {
    expect(priceKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(priceKey("gpt-4o-mini")).toBe("gpt-4o-mini");
    // gpt-4o-mini-tts starts with gpt-4o-mini but must price as TTS, not chat.
    expect(priceKey("gpt-4o-mini-tts")).toBe("gpt-4o-mini-tts");
    expect(priceKey("tavus-cvi")).toBe("tavus-cvi");
  });

  it("attributes each model to the vendor that bills it", () => {
    expect(vendorForModel("claude-haiku-4-5")).toBe("anthropic");
    expect(vendorForModel("gpt-4o-mini-tts")).toBe("openai");
    expect(vendorForModel("tavus-cvi")).toBe("tavus");
  });

  it("estimates LLM cost from input + output tokens", () => {
    // haiku: $1/Mtok in, $5/Mtok out → 1000 in + 200 out = 0.001 + 0.001 = 0.002
    const usd = estimateCostUsd({ vendor: "anthropic", operation: "compose", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200 });
    expect(usd).toBeCloseTo(0.002, 6);
  });

  it("estimates TTS cost per character and video cost per minute", () => {
    // gpt-4o-mini-tts: $12/Mchar → 1000 chars = 0.012
    expect(estimateCostUsd({ vendor: "openai", operation: "tts", model: "gpt-4o-mini-tts", chars: 1000 })).toBeCloseTo(0.012, 6);
    // tavus-cvi: $0.30/min → 120s = 2 min = 0.60
    expect(estimateCostUsd({ vendor: "tavus", operation: "video", model: "tavus-cvi", seconds: 120 })).toBeCloseTo(0.6, 6);
  });

  it("returns 0 cost for an unknown model (counts are still kept)", () => {
    expect(estimateCostUsd({ vendor: "other", operation: "compose", model: "mystery-model", inputTokens: 1000 })).toBe(0);
  });
});

describe("UsageLedger", () => {
  it("records events, attributes them per session, and rolls up cost by vendor", () => {
    const l = new UsageLedger();
    l.record({ sessionId: "s1", vendor: "anthropic", operation: "compose", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200 });
    l.record({ sessionId: "s1", vendor: "openai", operation: "tts", model: "gpt-4o-mini-tts", chars: 500 });
    l.record({ sessionId: "s2", vendor: "anthropic", operation: "compose", model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 100 });

    expect(l.forSession("s1")).toHaveLength(2);
    const s1 = l.sessionSummary("s1");
    expect(s1.events).toBe(2);
    expect(s1.byVendor.anthropic).toBeCloseTo(0.002, 6);
    expect(s1.byVendor.openai).toBeCloseTo(0.006, 6); // 500 chars × $12/M

    const per = l.perSession();
    expect(per).toHaveLength(2);
    expect(per[0]!.sessionId).toBe("s1"); // highest cost first
  });

  it("skips empty records (no tokens/chars/seconds) so the feed isn't polluted", () => {
    const l = new UsageLedger();
    expect(l.record({ vendor: "anthropic", operation: "compose", model: "x" })).toBeNull();
    expect(l.summary().events).toBe(0);
  });

  it("attributes cost per user and buckets per day with a running cumulative", () => {
    const l = new UsageLedger();
    l.record({ owner: "alice", sessionId: "s1", vendor: "anthropic", operation: "compose", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200 }); // $0.002
    l.record({ owner: "bob", sessionId: "s2", vendor: "anthropic", operation: "compose", model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 400 }); // $0.004

    const per = l.perUser();
    expect(per.map((u) => u.owner)).toEqual(["bob", "alice"]); // higher spender first
    expect(l.summary().byUser.alice).toBeCloseTo(0.002, 6);

    const days = l.perDay();
    expect(days).toHaveLength(1); // one test run → one UTC day
    expect(days[0]!.cumulativeCostUsd).toBeCloseTo(l.summary().totalCostUsd, 6);
    expect(l.perDay({ owner: "alice" })[0]!.estCostUsd).toBeCloseTo(0.002, 6); // scoped to one user
  });
});

describe("ledger durability (dump / load for Postgres snapshots)", () => {
  it("usage dump/load round-trips and only fills an EMPTY ledger (first-write-wins)", () => {
    const l = new UsageLedger();
    l.record({ owner: "alice", vendor: "anthropic", operation: "compose", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 200 });
    const snap = l.dumpEvents();
    expect(snap).toHaveLength(1);

    const restored = new UsageLedger();
    restored.loadEvents(snap);
    expect(restored.summary().events).toBe(1);
    expect(restored.summary().byUser.alice).toBeCloseTo(0.002, 6);

    restored.loadEvents([{ ...snap[0]!, id: "dupe" }]); // non-empty → ignored, so a live event isn't clobbered
    expect(restored.summary().events).toBe(1);
  });

  it("activity dump/load round-trips and won't clobber a live log", () => {
    clearActivity();
    recordActivity({ category: "system", action: "boot" });
    const snap = dumpActivity();
    expect(snap).toHaveLength(1);

    clearActivity();
    loadActivity(snap);
    expect(queryActivity().summary.total).toBe(1);

    recordActivity({ category: "system", action: "live event" }); // store now non-empty
    loadActivity(snap); // ignored — must not drop the live event
    expect(queryActivity().summary.total).toBe(2);
    clearActivity();
  });
});
