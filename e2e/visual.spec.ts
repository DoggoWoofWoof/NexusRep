import { expect, test } from "@playwright/test";

/**
 * Visual regression baselines (brief §22.4). Generate/refresh with:
 *   npm run e2e:update-snapshots
 *
 * Visual checks must catch header clipping, hidden tabs, overlapping controls,
 * `[object Object]`, cramped tables, and the doctor view showing internal terms.
 * Stage 1 baselines the two scaffolded screens; later stages add Build, Train,
 * Audience, Launch, Sessions, Session Review, Analytics, Follow-ups, HCP invite.
 */

test("overview screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Good morning/i })).toBeVisible();
  await expect(page).toHaveScreenshot("overview.png", { fullPage: true });
});

test("av spike screen (idle)", async ({ page }) => {
  await page.goto("/spike");
  await expect(page.getByRole("heading", { name: /Rehearsal/i })).toBeVisible();
  await expect(page).toHaveScreenshot("spike.png", { fullPage: true });
});

test("hcp invite screen", async ({ page }) => {
  await page.goto("/hcp");
  // Wait for the brand-resolved copy (async /api/brand) so the screenshot is deterministic —
  // the heading name includes the product only once useBrand() has loaded.
  await expect(page.getByRole("heading", { name: /You're invited to an AI-guided session on Milvexian/i })).toBeVisible();
  await expect(page.getByText(/investigational oral Factor XIa/i)).toBeVisible();
  await expect(page).toHaveScreenshot("hcp.png", { fullPage: true });
});

// Build/Train visual baselines live in visual-studio.spec.ts (the serial `mutating`
// project): the parallel suite mutates studio state (uploads, setup answers, coaching
// rules), so those shots are only deterministic AFTER the full chromium pass.

test("audience screen", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByText("Audience", { exact: false }).first().click();
  await expect(page.getByRole("heading", { name: /Who should the rep speak to/i })).toBeVisible();
  // Wait for the LIVE (modeled, deterministic under e2e) cohort — not the fixture flash.
  await expect(page.getByTestId("audience-row").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/of \d+ doctors/)).toBeVisible();
  await expect(page).toHaveScreenshot("audience.png", { fullPage: true });
});
