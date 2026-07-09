import { expect, test } from "@playwright/test";

/**
 * Live 3D avatar verification — drives the REAL TalkingHead + HeadTTS path in a
 * GPU-backed browser. Guarded by VERIFY_3D so it never runs in the normal suite
 * (it needs WebGPU + a network model download). Run explicitly:
 *
 *   VERIFY_3D=1 npx playwright test live3d.verify --headed
 *
 * It reports whether LiveAvatar reached state="ready" (3D + neural voice worked)
 * or fell back to "error", captures console output, and screenshots the avatar.
 */

test.skip(!process.env.VERIFY_3D, "set VERIFY_3D=1 to run the GPU/WebGPU verification");

// Use locally-installed Edge (Chromium, ships with Windows 11, supports WebGPU)
// in headed mode for a real GPU.
test.use({
  channel: "msedge",
  headless: false,
  launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] },
});

test("Live 3D avatar loads and speaks on /spike", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto("/spike");
  await expect(page.getByRole("heading", { name: /Rehearsal/i })).toBeVisible();

  // Turn on Live 3D and wait for it to either become ready or error.
  await page.getByRole("button", { name: /Live 3D: off/i }).click();
  const avatar = page.getByTestId("live-avatar");

  await expect
    .poll(async () => avatar.getAttribute("data-live-state"), { timeout: 120_000, intervals: [2000] })
    .not.toBe("loading");

  const state = await avatar.getAttribute("data-live-state");
  const canvasCount = await avatar.locator("canvas").count();

  // Start the rehearsal so it actually speaks through whichever engine loaded.
  await page.getByRole("button", { name: /Start rehearsal/i }).click();
  await expect(page.getByTestId("spike-ended")).toBeVisible({ timeout: 60_000 });
  const endedText = await page.getByTestId("spike-ended").textContent();

  await page.screenshot({ path: "test-results/live3d-spike.png", fullPage: true });

  console.log("=== LIVE 3D VERIFICATION ===");
  console.log("data-live-state:", state);
  console.log("canvas elements in avatar:", canvasCount);
  console.log("ended label:", endedText);
  console.log("browser console tail:\n" + logs.slice(-25).join("\n"));
});
