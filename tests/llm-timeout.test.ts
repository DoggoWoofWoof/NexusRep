/**
 * The non-grounded LLM helpers (llmComplete/llmText — setup inference, rule compaction) run on request
 * paths like content/ingest and previously had NO abort, so a hung provider call hung the upload. They
 * now pass a bounded AbortSignal and degrade to null on error/timeout instead of hanging or throwing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshComposer(timeoutMs = 5000) {
  vi.resetModules();
  delete process.env.ANTHROPIC_API_KEY; // force the OpenAI-compatible fetch branch
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.NEXUSREP_LLM_TIMEOUT_MS = String(timeoutMs);
  return import("@modules/content/composer");
}

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.NEXUSREP_LLM_TIMEOUT_MS;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("llmComplete — bounded on the ingest path", () => {
  it("passes a bounded abort signal to the provider call", async () => {
    const { llmComplete } = await freshComposer();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await llmComplete("sys", "user")).toBe("ok");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal); // → a slow provider gets aborted, not awaited forever
  });

  it("degrades to null (never hangs or throws) when the provider errors/aborts", async () => {
    const { llmComplete } = await freshComposer();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    expect(await llmComplete("s", "u")).toBeNull();
  });

  it("returns null when the provider responds non-2xx", async () => {
    const { llmComplete } = await freshComposer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await llmComplete("s", "u")).toBeNull();
  });
});
