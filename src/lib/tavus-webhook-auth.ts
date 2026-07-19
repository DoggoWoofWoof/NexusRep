/**
 * Tavus webhook authentication. Two problems with the old inline check:
 *   1. It FAILED OPEN — when TAVUS_LLM_KEY was unset the check was skipped, so anyone who learned a
 *      conversation id could POST a fake recording_ready and attach an arbitrary URL to a session.
 *   2. It put the MASTER key in the callback URL (`?k=<TAVUS_LLM_KEY>`), which lands in access/proxy
 *      logs.
 *
 * Fix: fail CLOSED (no key configured → refuse), and put a per-owner HMAC SIGNATURE in the URL instead
 * of the raw key. We build the callback URL ourselves at conversation start (Tavus just POSTs to it and
 * can't add a custom header), so the signature is the best available: it's stateless (recomputed from
 * the `?u=` owner on the callback), the master key never appears in a URL, and leaking a signature only
 * lets an attacker forge callbacks for that ONE owner — never reveals the key or affects others. A raw
 * key via header is also accepted, for a proxy or manual caller that CAN keep the secret out of the URL.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/** Per-owner webhook signature = HMAC(TAVUS_LLM_KEY, "tavus-webhook:<owner>"). Goes in the callback
 *  URL's `?k=` in place of the raw key. `owner` is the internal username (or "" for a public link). */
export function tavusWebhookToken(owner: string): string {
  return createHmac("sha256", env.tavusLlmKey || "nexusrep").update(`tavus-webhook:${owner}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type WebhookAuth = { ok: true } | { ok: false; status: number; error: string };

/**
 * Verify a Tavus webhook request. Fails CLOSED when no key is configured. Accepts either the raw key
 * via header (`Authorization: Bearer …` or `x-nexusrep-webhook-key`) OR the per-owner signature via
 * `?k=` (what Tavus sends). Owner comes from `?u=` and is folded into the signature check.
 */
export function verifyTavusWebhook(req: Request): WebhookAuth {
  if (!env.tavusLlmKey) return { ok: false, status: 401, error: "webhook auth not configured (set TAVUS_LLM_KEY)" };

  // Header path: a proxy or manual caller can keep the secret entirely out of the URL.
  const header = (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-nexusrep-webhook-key") ?? "").trim();
  if (header && safeEqual(header, env.tavusLlmKey)) return { ok: true };

  // Query path: Tavus POSTs to the URL we registered → ?k=<per-owner signature>&u=<owner>.
  const params = new URL(req.url).searchParams;
  const k = params.get("k") ?? "";
  const owner = params.get("u") ?? "";
  if (k && safeEqual(k, tavusWebhookToken(owner))) return { ok: true };

  return { ok: false, status: 401, error: "unauthorized" };
}
