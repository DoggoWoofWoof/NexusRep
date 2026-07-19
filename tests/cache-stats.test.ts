import { describe, it, expect, beforeEach } from "vitest";
import { recordCacheHit, recordCacheMiss, registerCacheSize, cacheStatsSnapshot, __resetCacheStatsForTests } from "@lib/cache-stats";

describe("cache stats", () => {
  beforeEach(() => __resetCacheStatsForTests());

  it("tracks hit rate as the share of cacheable requests served free", () => {
    recordCacheHit("tts-clips");
    recordCacheHit("tts-clips");
    recordCacheHit("tts-clips");
    recordCacheMiss("tts-clips"); // 3 served free, 1 real generation → 75%
    const s = cacheStatsSnapshot().find((c) => c.name === "tts-clips")!;
    expect(s.hits).toBe(3);
    expect(s.misses).toBe(1);
    expect(s.total).toBe(4);
    expect(s.hitRate).toBeCloseTo(0.75, 5);
  });

  it("exposes a live entry count via a registered size probe", () => {
    let size = 0;
    registerCacheSize("probe", () => size);
    recordCacheMiss("probe");
    size = 5;
    expect(cacheStatsSnapshot().find((c) => c.name === "probe")!.entries).toBe(5);
  });

  it("reports 0 hit rate (not NaN) before any activity", () => {
    registerCacheSize("empty", () => 0);
    expect(cacheStatsSnapshot().find((c) => c.name === "empty")!.hitRate).toBe(0);
  });
});
