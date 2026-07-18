/**
 * Pacing rates are MEASURED per engine (2026-07-18), not guessed — and a live Tavus replica turn is
 * startup latency + speaking time, not one inflated per-word slope. These tests pin the measured
 * constants and the startup-inclusive replica model so a future "simplify to one number" can't
 * silently reintroduce the mis-timing (short lines cut off / long lines dead air).
 */

import { describe, expect, it } from "vitest";
import {
  TTS_MS_PER_WORD,
  REPLICA_MS_PER_WORD,
  REPLICA_STARTUP_MS,
  estimateReplicaTurnMs,
  estimateSegmentSpeechMs,
} from "@lib/pacing";
import { estimateSpeechMs } from "@lib/browser-speech";

const words = (n: number): string => Array(n).fill("word").join(" ");

describe("pacing — measured per-engine rates", () => {
  it("keeps the two engines' measured rates distinct (OpenAI ~408→400, Tavus replica ~301→305)", () => {
    expect(TTS_MS_PER_WORD).toBe(400);
    expect(REPLICA_MS_PER_WORD).toBe(305);
    expect(REPLICA_STARTUP_MS).toBe(1_200);
    // The replica voice is FASTER than the video-off voice — the whole point of not sharing a number.
    expect(REPLICA_MS_PER_WORD).toBeLessThan(TTS_MS_PER_WORD);
  });

  it("video-off TTS estimate = words × rate, floored", () => {
    expect(estimateSpeechMs(words(10))).toBe(10 * TTS_MS_PER_WORD);
    expect(estimateSpeechMs("hi")).toBe(700); // short floor
  });
});

describe("estimateReplicaTurnMs — startup + speaking time", () => {
  it("includes the fixed startup latency, not just per-word time", () => {
    // In the linear region the delta between two lengths is pure speaking time…
    expect(estimateReplicaTurnMs(words(30)) - estimateReplicaTurnMs(words(20))).toBe(10 * REPLICA_MS_PER_WORD);
    // …and the absolute value carries the startup offset (30w is well clear of the floor/cap).
    expect(estimateReplicaTurnMs(words(30))).toBe(REPLICA_STARTUP_MS + 30 * REPLICA_MS_PER_WORD);
  });

  it("floors short lines (a one-word turn still costs the startup + more) and caps very long ones", () => {
    expect(estimateReplicaTurnMs("go")).toBe(2_400); // floor
    expect(estimateReplicaTurnMs(words(500))).toBe(45_000); // cap
  });

  it("a typical overview segment (~20 words) lands near the old flat-360 value but is structured", () => {
    // 1200 + 20*305 = 7300 vs the old 360*20 = 7200 — close for typical lengths (why 360 wasn't awful),
    // but the model now also gets short/long segments right.
    expect(estimateReplicaTurnMs(words(20))).toBe(7_300);
  });
});

describe("estimateSegmentSpeechMs — transcript spacing (floored/capped replica walk)", () => {
  it("floors short segments so a run of them doesn't bunch to one second", () => {
    expect(estimateSegmentSpeechMs("ok")).toBe(5_500);
  });
  it("tracks the replica turn estimate in the middle band", () => {
    expect(estimateSegmentSpeechMs(words(20))).toBe(7_300);
  });
});
