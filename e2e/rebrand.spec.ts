import { expect, test, type Page } from "@playwright/test";

/**
 * Re-brand-by-chat proof. This test MUTATES global server state (the brand name), so it
 * runs in its own dependent Playwright project AFTER the parallel suite — a rename window
 * mid-run made the /hcp visual snapshot land on the wrong brand. It restores the original
 * name and VERIFIES the restore before finishing.
 */

const nav = (page: Page, label: string) => page.locator("aside").getByText(label, { exact: false }).first();

async function chatBrandAnswer(page: Page, name: string) {
  await page.goto("/");
  await nav(page, "AI Rep").click();
  await expect(page.getByText(/Setup Assistant/i)).toBeVisible();
  const chat = page.getByPlaceholder(/Type an answer/i);
  await chat.fill(name);
  await chat.press("Enter");
  // The setup POST is fire-and-forget in the UI — wait until the server actually
  // reflects the new name before navigating (this race broke the first version).
  await expect
    .poll(async () => ((await (await page.request.get("/api/brand")).json()) as { displayName?: string }).displayName ?? "", { timeout: 15_000 })
    .toBe(name);
}

test("re-branding by chat re-themes the doctor view — then restore", async ({ page }) => {
  const original = ((await (await page.request.get("/api/brand")).json()) as { displayName: string }).displayName;
  try {
    await chatBrandAnswer(page, "CardioNova");
    await page.goto("/hcp");
    await expect(page.getByRole("heading", { name: /session on CardioNova/i })).toBeVisible({ timeout: 15_000 });
  } finally {
    await chatBrandAnswer(page, original);
  }
  await page.goto("/hcp");
  await expect(page.getByRole("heading", { name: new RegExp(`session on ${original}`, "i") })).toBeVisible({ timeout: 15_000 });
});
