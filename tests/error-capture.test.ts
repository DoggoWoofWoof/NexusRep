/**
 * captureError: ALWAYS structured-logs on our side (full error + context), forwards to a registered
 * external sink (opt-in), wraps non-Error throwables, and never throws — even if the sink throws.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  process.env.NEXUSREP_LOG_FORMAT = "json";
  process.env.NEXUSREP_LOG_LEVEL = "debug";
  return import("@lib/error-capture");
}

afterEach(() => {
  delete process.env.NEXUSREP_LOG_FORMAT;
  delete process.env.NEXUSREP_LOG_LEVEL;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("captureError", () => {
  it("structured-logs the error with its phase + context at error level", async () => {
    const { captureError } = await fresh();
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    captureError(new Error("kaboom"), { phase: "test.x", sessionId: "s1" });
    const obj = JSON.parse(String(spy.mock.calls[0]![0]));
    expect(obj.level).toBe("error");
    expect(obj.phase).toBe("test.x");
    expect(obj.sessionId).toBe("s1");
    expect(obj.error.message).toBe("kaboom");
  });

  it("forwards to a registered sink and wraps a non-Error throwable into an Error", async () => {
    const { captureError, registerErrorSink, hasExternalSink } = await fresh();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(hasExternalSink()).toBe(false);
    const sink = vi.fn();
    registerErrorSink(sink);
    expect(hasExternalSink()).toBe(true);
    captureError("string failure", { phase: "p" });
    expect(sink).toHaveBeenCalledTimes(1);
    const passed = sink.mock.calls[0]![0] as Error;
    expect(passed).toBeInstanceOf(Error);
    expect(passed.message).toBe("string failure");
  });

  it("never throws even if the external sink throws", async () => {
    const { captureError, registerErrorSink } = await fresh();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    registerErrorSink(() => {
      throw new Error("sink is broken");
    });
    expect(() => captureError(new Error("x"))).not.toThrow();
  });
});
