/**
 * Small shared crypto helpers, so the two auth files (auth-session, tavus-webhook-auth) don't each
 * re-implement a constant-time string compare or re-declare the HMAC fallback secret (which must never
 * diverge).
 */

import { timingSafeEqual } from "node:crypto";

/** Last-ditch HMAC key used only when the real secret is unset (dev / unconfigured). NOT a real
 *  secret — a deterministic placeholder shared so the fallback can't differ across signers. */
export const HMAC_FALLBACK_SECRET = "nexusrep";

/** Constant-time UTF-8 string equality, length-guarded (unequal lengths short-circuit to false). */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
