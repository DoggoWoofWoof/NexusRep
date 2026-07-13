/**
 * Voice-tone must have a REAL, distinct effect — or it shouldn't exist. These lock in that
 * the two things the tone knob drives are genuinely different per tone:
 *  - toneDirective  → the style directive fed to the grounded composer (changes WORDING when an
 *                     LLM composer is configured; layered under grounding so it adds no facts).
 *  - toneSpeechOpts → the browser-TTS rate/pitch (changes how the built-in voice SOUNDS, always).
 */

import { describe, expect, it } from "vitest";
import { toneDirective } from "@modules/aiRepStudio";
import { toneSpeechOpts } from "@lib/browser-speech";

describe("voice tone actually changes the rep", () => {
  it("toneDirective yields a distinct, non-empty style directive per tone (empty for unknown)", () => {
    const pro = toneDirective("professional");
    const warm = toneDirective("warm");
    const clin = toneDirective("clinical");
    expect(pro).toBeTruthy();
    expect(warm).toBeTruthy();
    expect(clin).toBeTruthy();
    expect(new Set([pro, warm, clin]).size).toBe(3); // all three differ
    expect(toneDirective(undefined)).toBe("");
    expect(toneDirective("bogus")).toBe("");
  });

  it("toneSpeechOpts changes TTS delivery (rate/pitch) per tone", () => {
    const warm = toneSpeechOpts("warm");
    const clin = toneSpeechOpts("clinical");
    const pro = toneSpeechOpts("professional");
    // Warm is gentler/higher than the clinical register.
    expect(warm.pitch!).toBeGreaterThan(clin.pitch!);
    expect(warm.rate!).toBeGreaterThan(clin.rate!);
    // Three tones → three distinct (rate, pitch) pairs.
    const key = (o: { rate?: number; pitch?: number }) => `${o.rate}/${o.pitch}`;
    expect(new Set([warm, clin, pro].map(key)).size).toBe(3);
    // Unknown/unset tone → no delivery override (neutral default).
    expect(toneSpeechOpts(undefined)).toEqual({});
  });
});
