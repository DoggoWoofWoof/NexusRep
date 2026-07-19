/**
 * Auth / roles / multi-tenancy E2E. The main suite runs auth OFF, so this path had ZERO end-to-end
 * coverage. Runs against the auth-ON server (playwright.config "auth" project → AUTH_BASE_URL, with a
 * real NEXUSREP_SESSION_SECRET so the brand API 401s rather than 503s). API-level assertions are the
 * security boundary; a couple of UI checks confirm the console/nav gate too.
 */

import { test, expect } from "@playwright/test";
import type { APIResponse } from "@playwright/test";

const login = (page: import("@playwright/test").Page, username: string, password: string) =>
  page.request.post("/api/auth", { data: { action: "login", username, password } });

const sessionCount = async (res: APIResponse): Promise<number> => {
  const body: unknown = await res.json();
  if (Array.isArray(body)) return body.length;
  // /api/sessions returns { rows: [...] } (display-shaped); keep array/sessions fallbacks.
  const b = body as { rows?: unknown[]; sessions?: unknown[] };
  const list = b?.rows ?? b?.sessions;
  return Array.isArray(list) ? list.length : 0;
};

test.describe("auth, roles & multi-tenancy (auth ON)", () => {
  test("unauthenticated: login screen shown, brand API 401, doctor link never gated", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('input[type="password"]')).toBeVisible(); // login screen, not the console
    expect((await page.request.get("/api/sessions")).status()).toBe(401);
    expect((await page.request.get("/api/studio")).status()).toBe(401);
    // The doctor experience is reached by link and is never gated.
    expect((await page.request.get("/hcp")).status()).toBeLessThan(400);
  });

  test("member signs in: brand API works, internal surfaces 403, admin nav hidden", async ({ page }) => {
    const res = await login(page, "mahek", "mahek123");
    expect(res.ok()).toBeTruthy();
    expect(((await res.json()) as { isAdmin?: boolean }).isAdmin).toBe(false);

    expect((await page.request.get("/api/sessions")).status()).toBe(200); // member has brand access
    expect((await page.request.get("/api/activity")).status()).toBe(403); // admin-only → forbidden
    expect((await page.request.get("/api/integrations")).status()).toBe(403); // admin-only → forbidden

    await page.goto("/");
    await expect(page.locator('input[type="password"]')).toHaveCount(0); // authed console, not login
    await expect(page.getByText("Platform Admin")).toHaveCount(0); // admin nav hidden for a member
  });

  test("admin signs in: internal surfaces 200, admin nav visible", async ({ page }) => {
    const res = await login(page, "swastik", "swastik123");
    expect(((await res.json()) as { isAdmin?: boolean }).isAdmin).toBe(true);
    expect((await page.request.get("/api/activity")).status()).toBe(200);
    expect((await page.request.get("/api/integrations")).status()).toBe(200);

    await page.goto("/");
    await expect(page.getByText("Platform Admin")).toBeVisible();
  });

  test("bad credentials are rejected (401)", async ({ page }) => {
    expect((await login(page, "mahek", "wrong-password")).status()).toBe(401);
    expect((await page.request.get("/api/sessions")).status()).toBe(401); // still unauthenticated
  });

  test("per-user isolation: a demo user has seeded sessions; a clean user starts empty", async ({ page }) => {
    await login(page, "mahek", "mahek123");
    const demo = await sessionCount(await page.request.get("/api/sessions"));

    await page.request.post("/api/auth", { data: { action: "logout" } });
    await login(page, "clean", "clean123");
    const clean = await sessionCount(await page.request.get("/api/sessions"));

    expect(demo).toBeGreaterThan(0); // mahek = clone-the-demo data
    expect(clean).toBe(0); // clean = blank slate → the two users' stores are isolated
  });
});
