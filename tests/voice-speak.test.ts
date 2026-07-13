/**
 * The rep-voice TTS endpoint (used off-video) must fail SAFE: empty text, no / invalid TTS key,
 * or any error returns 204 (no live call) so the client falls back to the browser voice.
 */

import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/voice/speak/route";

afterEach(() => { delete process.env.OPENAI_API_KEY; });

function req(body: unknown): Request {
  return new Request("http://localhost/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("rep-voice TTS endpoint (fail-safe)", () => {
  it("204 on empty text", async () => {
    expect((await POST(req({ text: "   " }))).status).toBe(204);
  });

  it("204 when no TTS key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    expect((await POST(req({ text: "Hello, doctor.", tone: "warm" }))).status).toBe(204);
  });

  it("204 for a malformed key without making a live call", async () => {
    process.env.OPENAI_API_KEY = "sk-proj-real\\nOPENAI_MODEL=gpt-4o-mini";
    expect((await POST(req({ text: "Hello, doctor.", voice: "shimmer" }))).status).toBe(204);
  });
});
