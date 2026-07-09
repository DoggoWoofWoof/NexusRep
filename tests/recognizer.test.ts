import { describe, expect, it } from "vitest";
import { createRecognizer } from "@lib/browser-speech";

// In node/jsdom test env, neither MediaRecorder+getUserMedia (Whisper) nor
// SpeechRecognition (browser) exist, so the factory must degrade to the no-op
// stub: supported() === false, and start/stop never throw. Deterministic + offline.
describe("createRecognizer factory", () => {
  it("returns an object with supported/start/stop functions", () => {
    const rec = createRecognizer();
    expect(typeof rec.supported).toBe("function");
    expect(typeof rec.start).toBe("function");
    expect(typeof rec.stop).toBe("function");
  });

  it("falls back to an unsupported stub when no speech APIs are present", () => {
    expect(createRecognizer().supported()).toBe(false);
    expect(createRecognizer("whisper").supported()).toBe(false);
    expect(createRecognizer("browser").supported()).toBe(false);
  });

  it("stub start() invokes onEnd and never throws", () => {
    const rec = createRecognizer();
    let ended = false;
    expect(() => {
      rec.start(
        () => {
          throw new Error("onResult should not fire without audio support");
        },
        () => {
          ended = true;
        },
      );
      rec.stop();
    }).not.toThrow();
    expect(ended).toBe(true);
  });
});
