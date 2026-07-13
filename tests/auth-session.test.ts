/**
 * The console auth gate: OFF unless a password is set, correct password mints a cookie that
 * validates, wrong/empty password is rejected, and a tampered cookie is rejected. Uses env
 * mutation because appAuthEnabled/passwordMatches read the frozen env snapshot at call time.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshAuth(password: string) {
  vi.resetModules();
  process.env.NEXUSREP_APP_PASSWORD = password;
  delete process.env.NEXUSREP_SESSION_SECRET;
  return import("@lib/auth-session");
}

afterEach(() => {
  delete process.env.NEXUSREP_APP_PASSWORD;
  delete process.env.NEXUSREP_SESSION_SECRET;
  vi.resetModules();
});

describe("brand-console auth session", () => {
  it("is disabled (open) when no password is configured", async () => {
    const a = await freshAuth("");
    expect(a.appAuthEnabled()).toBe(false);
    expect(a.cookieIsValid(undefined)).toBe(true); // no cookie needed when open
    expect(a.passwordMatches("anything")).toBe(false);
  });

  it("accepts the right password and its minted cookie; rejects wrong/empty/tampered", async () => {
    const a = await freshAuth("s3cret-demo");
    expect(a.appAuthEnabled()).toBe(true);
    expect(a.passwordMatches("s3cret-demo")).toBe(true);
    expect(a.passwordMatches("s3cret-demoX")).toBe(false);
    expect(a.passwordMatches("")).toBe(false);

    const token = a.sessionToken();
    expect(a.cookieIsValid(token)).toBe(true);
    expect(a.cookieIsValid(undefined)).toBe(false);
    expect(a.cookieIsValid("")).toBe(false);
    expect(a.cookieIsValid(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"))).toBe(false); // tampered
  });

  it("a cookie minted under one secret does not validate under another", async () => {
    const a1 = await freshAuth("pw-one");
    const stale = a1.sessionToken();
    const a2 = await freshAuth("pw-two");
    expect(a2.cookieIsValid(stale)).toBe(false);
  });
});
