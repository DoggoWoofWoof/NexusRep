import { describe, it, expect } from "vitest";
import { UsageLedger, estimateCostUsd, priceKey, vendorForModel } from "@modules/usage";

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
});
