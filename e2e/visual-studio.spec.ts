import { expect, test } from "@playwright/test";

/**
 * Studio visual baselines — run in the SERIAL `mutating` project AFTER the parallel
 * suite: Build/Train state is mutated by other specs (setup answers, uploads, coaching
 * rules), so the post-suite state is the deterministic one. The Build shot keeps the
 * Approved-knowledge section CLOSED — upload ids are timestamped and would differ per run.
 */

test("studio build screen", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByText("AI Rep", { exact: false }).first().click();
  await expect(page.getByText(/Setup Assistant/i)).toBeVisible();
  await expect(page.getByText("Rep profile", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveScreenshot("studio-build.png", { fullPage: true });
});

test("studio train screen", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByText("AI Rep", { exact: false }).first().click();
  await page.getByText("Training & Preview").click();
  await expect(page.getByText("Brand pitch").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/★ Rep's opening line/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Milvexian", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveScreenshot("studio-train.png", { fullPage: true });
});
