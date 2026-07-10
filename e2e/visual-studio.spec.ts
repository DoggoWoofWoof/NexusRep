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
  await page.getByText("Training", { exact: true }).click();
  await expect(page.getByText(/Deck/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/★ Rep's opening line/i)).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveScreenshot("studio-train.png", { fullPage: true });
});

test("studio pitch & script screen", async ({ page }) => {
  await page.goto("/");
  await page.locator("aside").getByText("AI Rep", { exact: false }).first().click();
  await page.getByText("Pitch & Script").click();
  await expect(page.getByText("Deck sources")).toBeVisible({ timeout: 15_000 });
  // The script auto-drafts from the approved deck (deterministic under the e2e env).
  await expect(page.getByText(/what the rep says, slide by slide/i)).toBeVisible();
  await expect(page.getByText("✎ Coach").first()).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Brand pitch").first()).toBeVisible();
  await expect(page).toHaveScreenshot("studio-pitch.png", { fullPage: true });
});

test("studio agent gallery screen", async ({ page }) => {
  // The gallery lists live vendor agents — intercept with a fixture so the shot is
  // deterministic on any machine/account (initials placeholders, no thumbnails).
  await page.route("**/api/realtime/agents", (route) =>
    route.fulfill({
      json: {
        configured: true,
        selected: "agent_demo_luna",
        selectedName: "Luna",
        defaultReplicaId: "agent_demo_charlie",
        agents: [
          { id: "agent_own_1", name: "Dr. Patel — cardiology rep", kind: "personal", status: "training" },
          { id: "agent_demo_luna", name: "Luna - Office", kind: "stock", status: "ready" },
          { id: "agent_demo_charlie", name: "Charlie - Office", kind: "stock", status: "ready" },
          { id: "agent_demo_mary", name: "Mary - Studio", kind: "stock", status: "ready" },
          { id: "agent_demo_old", name: "Steph - Studio (Deprecated)", kind: "stock", status: "ready" },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.locator("aside").getByText("AI Rep", { exact: false }).first().click();
  await page.getByText("Agent", { exact: true }).click();
  await expect(page.getByText("Agent gallery")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("✓ In use").first()).toBeVisible();
  await expect(page.getByText("Your agent today")).toBeVisible();
  await expect(page).toHaveScreenshot("studio-agent.png", { fullPage: true });
});
