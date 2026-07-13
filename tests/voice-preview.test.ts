/**
 * The cached tone-voice endpoint must fail SAFE: with no / an obviously-invalid TTS key it returns
 * 204 (no live call), so the client falls back to the browser voice instead of erroring.
 */

import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/voice/preview/route";

afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe("voice preview endpoint (fail-safe)", () => {
  it("returns 204 when no TTS key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await GET(new Request("http://localhost/api/voice/preview?tone=warm"));
    expect(res.status).toBe(204);
  });

  it("returns 204 for an obviously-malformed key without making a live call", async () => {
    process.env.OPENAI_API_KEY = "sk-proj-real\\nOPENAI_MODEL=gpt-4o-mini"; // e.g. the glued-together value
    const res = await GET(new Request("http://localhost/api/voice/preview?tone=professional"));
    expect(res.status).toBe(204);
  });
});
