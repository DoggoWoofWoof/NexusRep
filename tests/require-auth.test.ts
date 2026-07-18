/**
 * requireBrandUser — the server-side gate on the brand-console API routes. Tested in isolation by
 * mocking its two deps (appAuthEnabled + currentUserId) so we can exercise every branch regardless of
 * the suite-wide NEXUSREP_AUTH=0. (End-to-end, the injected guard returns 401 when a real request has
 * no valid session cookie.)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const appAuthEnabled = vi.fn<() => boolean>();
const currentUserId = vi.fn<() => Promise<string | null>>();

vi.mock("@lib/auth-session", () => ({ appAuthEnabled: () => appAuthEnabled() }));
vi.mock("@lib/container", () => ({ currentUserId: () => currentUserId() }));

const { requireBrandUser } = await import("@lib/require-auth");

describe("requireBrandUser", () => {
  beforeEach(() => {
    appAuthEnabled.mockReset();
    currentUserId.mockReset();
  });

  it("allows any request when auth is disabled (dev / E2E / tests)", async () => {
    appAuthEnabled.mockReturnValue(false);
    const r = await requireBrandUser();
    expect(r.ok).toBe(true);
  });

  it("rejects with 401 when auth is on and there is no signed-in user", async () => {
    appAuthEnabled.mockReturnValue(true);
    currentUserId.mockResolvedValue(null);
    const r = await requireBrandUser();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.res.status).toBe(401);
  });

  it("allows and returns the username when auth is on and the cookie resolves", async () => {
    appAuthEnabled.mockReturnValue(true);
    currentUserId.mockResolvedValue("mahek");
    const r = await requireBrandUser();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user).toBe("mahek");
  });
});
