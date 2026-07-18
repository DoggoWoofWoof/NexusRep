/**
 * Multi-user console auth: the demo directory verifies credentials, signs a per-user cookie that
 * round-trips (and rejects tampering / a different secret), and maps each user to a data profile
 * (demo = clone the seeded demo, clean = unbuilt). Uses env mutation + module reset because the
 * auth helpers read the frozen env snapshot at import time.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshAuth() {
  vi.resetModules();
  process.env.NEXUSREP_AUTH = "1";
  process.env.NEXUSREP_SESSION_SECRET = "test-secret";
  return import("@lib/auth-session");
}

afterEach(() => {
  delete process.env.NEXUSREP_AUTH;
  delete process.env.NEXUSREP_SESSION_SECRET;
  vi.resetModules();
});

describe("multi-user console auth", () => {
  it("verifies correct credentials and rejects wrong / unknown (username case-insensitive)", async () => {
    const a = await freshAuth();
    expect(a.appAuthEnabled()).toBe(true);
    expect(a.verifyCredentials("mahek", "mahek123")?.username).toBe("mahek");
    expect(a.verifyCredentials("MAHEK", "mahek123")?.username).toBe("mahek");
    expect(a.verifyCredentials("mahek", "wrong")).toBeNull();
    expect(a.verifyCredentials("nobody", "x")).toBeNull();
    expect(a.verifyCredentials("swastik", "swastik123")?.username).toBe("swastik");
  });

  it("maps each user to a data profile (demo clones, clean is fresh)", async () => {
    const a = await freshAuth();
    expect(a.userData("mahek")).toBe("demo");
    expect(a.userData("lorick")).toBe("demo");
    expect(a.userData("nimit")).toBe("demo");
    expect(a.userData("swastik")).toBe("clean");
    expect(a.userData("clean")).toBe("clean");
    expect(a.userData(null)).toBeNull();
  });

  it("assigns a permission role ORTHOGONAL to the data profile (admin unlocks internal surfaces)", async () => {
    const a = await freshAuth();
    // swastik is the admin (a "clean"-data user who is ALSO an admin → role and data are independent).
    expect(a.userRole("swastik")).toBe("admin");
    expect(a.isAdminUser("swastik")).toBe(true);
    // Everyone else is a normal member — including "demo"-data users.
    for (const u of ["mahek", "lorick", "nimit", "ashwin", "clean"]) {
      expect(a.userRole(u)).toBe("member");
      expect(a.isAdminUser(u)).toBe(false);
    }
    // Unknown / signed-out is never an admin.
    expect(a.userRole("nobody")).toBeNull();
    expect(a.isAdminUser("nobody")).toBe(false);
    expect(a.isAdminUser(null)).toBe(false);
  });

  it("signs a cookie that round-trips the username; tampered / cross-secret rejected", async () => {
    const a = await freshAuth();
    const cookie = a.sessionCookieFor("nimit");
    expect(a.usernameFromCookie(cookie)).toBe("nimit");
    expect(a.usernameFromCookie(undefined)).toBeNull();
    expect(a.usernameFromCookie("nimit.deadbeef")).toBeNull(); // bad signature

    vi.resetModules();
    process.env.NEXUSREP_SESSION_SECRET = "different-secret";
    const a2 = await import("@lib/auth-session");
    expect(a2.usernameFromCookie(cookie)).toBeNull(); // signed under the old secret
  });

  it("is on by default and only disabled with NEXUSREP_AUTH=0 (E2E opt-out)", async () => {
    vi.resetModules();
    process.env.NEXUSREP_AUTH = "0";
    const off = await import("@lib/auth-session");
    expect(off.appAuthEnabled()).toBe(false);

    vi.resetModules();
    delete process.env.NEXUSREP_AUTH; // unset → gate ON (any deploy asks for sign-in)
    const on = await import("@lib/auth-session");
    expect(on.appAuthEnabled()).toBe(true);
  });
});

describe("per-user data isolation (container)", () => {
  it("a demo user clones the seeded demo; a clean user starts empty", async () => {
    const { getContainerForUser } = await import("@lib/container");
    const [mahek, clean] = await Promise.all([getContainerForUser("mahek"), getContainerForUser("clean")]);

    const [mahekSessions, mahekFollowups] = await Promise.all([mahek.sessions.list(), mahek.followups.list()]);
    const [cleanSessions, cleanFollowups] = await Promise.all([clean.sessions.list(), clean.followups.list()]);

    // Demo user: the seeded history is present.
    expect(mahekSessions.length).toBeGreaterThan(0);
    expect(mahekFollowups.length).toBeGreaterThan(0);
    // Clean user: a genuine blank slate — no sessions, follow-ups, or approved content.
    expect(cleanSessions.length).toBe(0);
    expect(cleanFollowups.length).toBe(0);
    expect((await clean.content.listAnswers()).length).toBe(0);
    // Demo user DID get approved content.
    expect((await mahek.content.listAnswers()).length).toBeGreaterThan(0);
    // Isolation: separate container instances.
    expect(mahek).not.toBe(clean);
  });
});
