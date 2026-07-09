import { describe, expect, it } from "vitest";
import { getComposer, resolveComposer } from "@modules/content";

describe("grounded answer composer registry", () => {
  it("exposes claude/openai/thinking-machines composers", () => {
    expect(getComposer("claude")?.name).toBe("claude");
    expect(getComposer("openai")?.name).toBe("openai");
    expect(getComposer("thinking-machines")?.name).toBe("thinking-machines");
    expect(getComposer("keyword")).toBeUndefined();
  });

  it("composers are unavailable without keys (offline) and never auto-selected", () => {
    expect(getComposer("claude")?.available()).toBe(false);
    expect(resolveComposer("claude")).toBeNull(); // no key in test env → deterministic builder
    expect(resolveComposer("keyword")).toBeNull();
  });
});
