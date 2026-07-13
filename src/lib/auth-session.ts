/**
 * Simple shared-password session for the brand console. Not a user directory — one password
 * (NEXUSREP_APP_PASSWORD) unlocks the console and mints a signed, httpOnly session cookie.
 *
 * OFF entirely when no password is configured, so local dev / E2E stay open. The doctor view
 * (/hcp) and the runtime endpoints it calls are never gated — this only fronts the console.
 * Server-only (imports node:crypto); the client just calls /api/auth.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const SESSION_COOKIE = "nexusrep_session";
const MARKER = "authed-v1";

export function appAuthEnabled(): boolean {
  return env.appPassword.length > 0;
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret || "nexusrep").update(data).digest();
}

/** Opaque session token stored in the cookie: HMAC of a fixed marker under the app secret. */
export function sessionToken(): string {
  return hmac(env.appSessionSecret, MARKER).toString("hex");
}

/** True when the cookie carries a currently-valid token (or when auth is disabled). */
export function cookieIsValid(raw: string | undefined | null): boolean {
  if (!appAuthEnabled()) return true;
  if (!raw) return false;
  const a = Buffer.from(raw, "utf8");
  const b = Buffer.from(sessionToken(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time, length-independent password check (both sides hashed to a fixed width). */
export function passwordMatches(input: string): boolean {
  if (!input || !env.appPassword) return false;
  return timingSafeEqual(hmac("nexusrep-pw", input), hmac("nexusrep-pw", env.appPassword));
}
