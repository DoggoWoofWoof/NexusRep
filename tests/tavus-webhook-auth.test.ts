/**
 * Tavus webhook auth: fails CLOSED when no key is configured, verifies a per-owner HMAC signature in
 * ?k= (the master key never rides in the URL), accepts the raw key via header, and rejects wrong
 * signatures / owner mismatches.
 */

import { afterEach, describe, expect, it } from "vitest";
import { env } from "@lib/env";
import { tavusWebhookToken, verifyTavusWebhook } from "@lib/tavus-webhook-auth";

const setKey = (k: string) => { (env as { tavusLlmKey: string }).tavusLlmKey = k; };
afterEach(() => setKey(""));

const wh = (query: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/tavus/webhook${query}`, { method: "POST", headers });

describe("verifyTavusWebhook", () => {
  it("fails CLOSED when no key is configured (was: skipped → open)", () => {
    setKey("");
    const r = verifyTavusWebhook(wh("?k=anything&u=x"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("accepts the per-owner signature in ?k=, rejects a wrong sig or owner mismatch", () => {
    setKey("secret");
    expect(verifyTavusWebhook(wh(`?k=${tavusWebhookToken("alice")}&u=alice`)).ok).toBe(true);
    expect(verifyTavusWebhook(wh(`?k=${tavusWebhookToken("alice")}&u=bob`)).ok).toBe(false); // owner-bound
    expect(verifyTavusWebhook(wh(`?k=deadbeef&u=alice`)).ok).toBe(false);
  });

  it("accepts a public-link signature (empty owner)", () => {
    setKey("secret");
    expect(verifyTavusWebhook(wh(`?k=${tavusWebhookToken("")}`)).ok).toBe(true);
  });

  it("accepts the raw key via header (kept out of the URL), rejects a wrong header", () => {
    setKey("secret");
    expect(verifyTavusWebhook(wh("?u=alice", { authorization: "Bearer secret" })).ok).toBe(true);
    expect(verifyTavusWebhook(wh("?u=alice", { "x-nexusrep-webhook-key": "secret" })).ok).toBe(true);
    expect(verifyTavusWebhook(wh("?u=alice", { authorization: "Bearer wrong" })).ok).toBe(false);
  });

  it("never puts the master key in the signature (HMAC hex, not the key)", () => {
    setKey("super-secret-key");
    const token = tavusWebhookToken("alice");
    expect(token).not.toContain("super-secret-key");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});
