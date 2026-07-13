/**
 * Simple multi-user auth for the brand console — a small fixed demo directory (not a real user
 * store). Each user logs in with a username + password and gets their OWN isolated container
 * (see getContainerForUser): "demo" users clone the full seeded demo (rep + content + history);
 * "clean" users get a fresh, unbuilt studio to build from scratch.
 *
 * OFF entirely unless the gate is enabled (NEXUSREP_AUTH=1 or legacy NEXUSREP_APP_PASSWORD),
 * so local dev / E2E stay open. The doctor view (/hcp) is never gated. Server-only (node:crypto).
 *
 * NOTE: these are DEMO credentials, intentionally in source so the accounts work out of the box
 * on any deploy. Not for production — swap for a real user store + hashed secrets there.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const SESSION_COOKIE = "nexusrep_session";

export type UserData = "demo" | "clean";

export interface DemoUser {
  username: string;
  password: string;
  name: string;
  /** "demo" → clone the seeded demo (rep + content + history); "clean" → unbuilt studio. */
  data: UserData;
}

export const DEMO_USERS: DemoUser[] = [
  { username: "mahek", password: "mahek123", name: "Mahek", data: "demo" },
  { username: "lorick", password: "lorick123", name: "Lorick", data: "demo" },
  { username: "nimit", password: "nimit123", name: "Nimit", data: "demo" },
  { username: "swastik", password: "swastik123", name: "Swastik", data: "clean" },
  { username: "clean", password: "clean123", name: "Clean", data: "clean" },
];

export function appAuthEnabled(): boolean {
  return env.authEnabled;
}

export function findUser(username: string): DemoUser | undefined {
  const u = username.trim().toLowerCase();
  return DEMO_USERS.find((d) => d.username === u);
}

/** Which data profile a signed-in user gets (null when unknown / not signed in). */
export function userData(username: string | null): UserData | null {
  if (!username) return null;
  return findUser(username)?.data ?? null;
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret || "nexusrep").update(data).digest();
}

/** Constant-time credential check. Returns the user record on success, else null. */
export function verifyCredentials(username: string, password: string): DemoUser | null {
  const u = findUser(username);
  if (!u || !password) return null;
  const ok = timingSafeEqual(hmac("nexusrep-pw", password), hmac("nexusrep-pw", u.password));
  return ok ? u : null;
}

function sign(username: string): string {
  return hmac(env.appSessionSecret, `user:${username}`).toString("hex");
}

/** The cookie value: the username plus a signature so the server trusts who is signed in. */
export function sessionCookieFor(username: string): string {
  return `${encodeURIComponent(username)}.${sign(username)}`;
}

/** Recover the signed-in username from a cookie value (null if missing/tampered/unknown user). */
export function usernameFromCookie(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const username = decodeURIComponent(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  const expected = sign(username);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return findUser(username) ? username : null;
}
