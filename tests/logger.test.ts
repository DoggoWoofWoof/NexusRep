/**
 * Structured logger: level gating, JSON line shape, child scopes, and robust serialization (Error
 * objects → message+stack, circular refs → "[Circular]", never throws into the caller). Uses env
 * mutation + module reset because the level threshold is captured at import time.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshLogger(level: string, format = "json") {
  vi.resetModules();
  process.env.NEXUSREP_LOG_LEVEL = level;
  process.env.NEXUSREP_LOG_FORMAT = format;
  return import("@lib/logger");
}

afterEach(() => {
  delete process.env.NEXUSREP_LOG_LEVEL;
  delete process.env.NEXUSREP_LOG_FORMAT;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logger", () => {
  it("emits one JSON line with level, msg, ts, and verbatim fields", async () => {
    const { logger } = await freshLogger("debug");
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    logger.info("hello", { a: 1, b: "x" });
    expect(spy).toHaveBeenCalledTimes(1);
    const obj = JSON.parse(String(spy.mock.calls[0]![0]));
    expect(obj).toMatchObject({ level: "info", msg: "hello", a: 1, b: "x" });
    expect(typeof obj.ts).toBe("string");
  });

  it("gates by level — info is suppressed when the threshold is warn", async () => {
    const { logger } = await freshLogger("warn");
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    logger.debug("no");
    logger.info("no");
    expect(spy).not.toHaveBeenCalled();
    logger.warn("yes");
    logger.error("yes");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("child() tags the scope (nested children chain with ':')", async () => {
    const { logger } = await freshLogger("debug");
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    logger.child("tavus").child("turn").info("m");
    expect(JSON.parse(String(spy.mock.calls[0]![0])).scope).toBe("tavus:turn");
  });

  it("serializes Error objects (message + stack) and survives circular refs without throwing", async () => {
    const { logger } = await freshLogger("debug");
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    expect(() => logger.error("boom", { error: new Error("bad"), circular })).not.toThrow();
    const obj = JSON.parse(String(spy.mock.calls[0]![0]));
    expect(obj.error.message).toBe("bad");
    expect(typeof obj.error.stack).toBe("string");
    expect(obj.circular.self).toBe("[Circular]");
  });

  it("pretty format routes to console (dev) instead of stdout JSON", async () => {
    const { logger } = await freshLogger("debug", "pretty");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const con = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.warn("hi", { a: 1 });
    expect(con).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });
});
