/**
 * The name→voice mapping must be STABLE (same agent name → same voice every time) and pick from
 * the allowed OpenAI voice set — so the same rep always previews in the same voice, and different
 * names mostly differ.
 */

import { describe, expect, it } from "vitest";
import { TTS_VOICES, voiceForName, isTtsVoice } from "@lib/tts-voices";

describe("name → voice mapping", () => {
  it("is deterministic (same name → same voice)", () => {
    expect(voiceForName("Charlie")).toBe(voiceForName("Charlie"));
    expect(voiceForName("Mary")).toBe(voiceForName("Mary"));
  });

  it("ignores case and surrounding whitespace (a name is one rep)", () => {
    expect(voiceForName("  Charlie ")).toBe(voiceForName("charlie"));
  });

  it("only ever returns an allowed voice", () => {
    for (const n of ["Charlie", "Mary", "Nimit", "Anna", "Jordan", "", "Zzz"]) {
      expect(isTtsVoice(voiceForName(n))).toBe(true);
    }
  });

  it("spreads different names across voices (not all the same)", () => {
    const names = ["Charlie", "Mary", "Anna", "Nimit", "Jordan", "Steph", "Omar", "Lena", "Raj", "Priya", "Ben", "Sofia"];
    const distinct = new Set(names.map(voiceForName));
    expect(distinct.size).toBeGreaterThan(3); // clearly not collapsing to one voice
    expect(TTS_VOICES.length).toBe(10);
  });
});
