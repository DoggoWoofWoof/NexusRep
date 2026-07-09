import { describe, expect, it } from "vitest";
import { estimateSpeechMs } from "@lib/browser-speech";

describe("estimateSpeechMs (pacing fallback)", () => {
  it("returns a sensible floor for short text", () => {
    expect(estimateSpeechMs("Hi")).toBeGreaterThanOrEqual(700);
  });

  it("scales with word count", () => {
    const short = estimateSpeechMs("one two three");
    const long = estimateSpeechMs("one two three four five six seven eight nine ten eleven twelve");
    expect(long).toBeGreaterThan(short);
  });
});
