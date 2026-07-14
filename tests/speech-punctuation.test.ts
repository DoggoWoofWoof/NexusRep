/**
 * stripSpeechMarkdown — the speech-text cleanup applied to every spoken rep answer. A TTS voice
 * reads a dash as an awkward hard stop ("Sure — let me…"), so dashes-as-pauses are turned into a
 * comma. In-word hyphens ("Fast-Track", "decile 2-4") must survive, and markdown must be stripped.
 */

import { describe, expect, it } from "vitest";
import { stripSpeechMarkdown } from "@modules/realtime/orchestrator";

describe("stripSpeechMarkdown — speech-friendly punctuation", () => {
  it("turns an em dash used as a pause into a comma", () => {
    expect(stripSpeechMarkdown("Sure — let me walk you through this.")).toBe("Sure, let me walk you through this.");
  });

  it("handles en dashes and ASCII double hyphens too", () => {
    expect(stripSpeechMarkdown("It works – broadly – like this.")).toBe("It works, broadly, like this.");
    expect(stripSpeechMarkdown("One point -- then another.")).toBe("One point, then another.");
  });

  it("turns a spaced single hyphen (dash pause) into a comma", () => {
    expect(stripSpeechMarkdown("Investigational - not yet approved.")).toBe("Investigational, not yet approved.");
  });

  it("leaves in-word hyphens intact", () => {
    const s = "Milvexian received Fast-Track designation; it is on-label for decile 2-4.";
    expect(stripSpeechMarkdown(s)).toBe(s);
  });

  it("still strips markdown emphasis", () => {
    expect(stripSpeechMarkdown("This is **important** and _investigational_.")).toBe("This is important and investigational.");
  });

  it("does not introduce a space before punctuation", () => {
    expect(stripSpeechMarkdown("Milvexian — an FXIa inhibitor.")).not.toMatch(/\s[,.]/);
  });
});
