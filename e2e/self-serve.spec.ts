import { expect, test, type Page } from "@playwright/test";

/**
 * Blank-slate self-serve journey — everything through the chat + UI only:
 * re-brand by chatting, add knowledge by uploading, approve it in the review queue,
 * and the doctor view immediately answers from it and shows its slide. Proves a new
 * brand needs zero code: profile richness is reproducible via setup + uploads.
 *
 * NOTE: the suite runs fullyParallel against one shared server, so the re-brand test
 * restores the original name before finishing (other specs assert the seeded brand).
 */

const nav = (page: Page, label: string) => page.locator("aside").getByText(label, { exact: false }).first();

async function openBuild(page: Page) {
  await page.goto("/");
  await nav(page, "AI Rep").click();
  await expect(page.getByText(/Setup Assistant/i)).toBeVisible();
}

test.describe("Self-serve setup (chat + UI only)", () => {
  // NOTE: the re-brand-by-chat test lives in rebrand.spec.ts — it mutates global server
  // state, so it runs in a dependent project AFTER this parallel suite.

  test("essentials come first; polish questions are labeled optional and skippable", async ({ page }) => {
    await openBuild(page);
    // Answer the eight essentials via the first suggestion chip each time.
    for (let i = 0; i < 8; i++) {
      await page.getByTestId("setup-chip").first().click();
    }
    // Now in the optional block: the pill + Skip control appear, and Skip advances.
    await expect(page.getByTestId("setup-optional")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("setup-skip").click();
    await expect(page.getByTestId("setup-optional")).toBeVisible(); // next optional question
  });

  test("Audience → 'Preview AI rep' runs the doctor view AS that doctor (real attribution)", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Audience").click();
    await expect(page.getByRole("heading", { name: /Who should the rep speak to/i })).toBeVisible();
    // Open the THIRD-ranked doctor's drawer (distinct from the demo default identity).
    await page.getByTestId("audience-row").nth(2).click();
    const doctorName = (await page.getByTestId("hcp-drawer-name").textContent({ timeout: 10_000 }))?.trim() ?? "";
    expect(doctorName.length).toBeGreaterThan(0);
    await page.getByTestId("hcp-drawer").getByRole("button", { name: /Preview AI rep/i }).click();
    // Doctor view opens; trigger an escalation so a follow-up records the identity.
    await page.getByRole("button", { name: /Start session/i }).click();
    const ask = page.getByPlaceholder(/Type or tap the mic|Type, or talk|Ask a question/i);
    await ask.fill("Can I use this off-label for pediatric patients?");
    await ask.press("Enter");
    await expect(page.getByText(/outside the approved information/i)).toBeVisible({ timeout: 20_000 });
    // A follow-up exists for the PREVIEWED doctor (surname match — display formatting differs;
    // parallel specs also create follow-ups, so check membership rather than "last row").
    const surname = doctorName.split(" ").slice(-1)[0]!;
    await expect
      .poll(async () => {
        const res = await page.request.get("/api/followups");
        const rows = ((await res.json()) as { rows?: { hcp: string }[] }).rows ?? [];
        return rows.some((r) => r.hcp.toLowerCase().includes(surname.toLowerCase()));
      }, { timeout: 15_000 })
      .toBe(true);
    // And the SESSION itself is attributed to that doctor — this is the direct check
    // (surname-only could pass by coincidence when the fallback demo doctor matches;
    // stripped drawer ids used to silently attribute preview sessions to the demo HCP).
    await expect
      .poll(async () => {
        const res = await page.request.get("/api/sessions");
        const rows = ((await res.json()) as { rows?: { hcp: string }[] }).rows ?? [];
        return rows.some((r) => r.hcp.toLowerCase().includes(surname.toLowerCase()));
      }, { timeout: 15_000 })
      .toBe(true);
  });

  test("upload → approve in the review queue → doctor view answers from it and shows its slide", async ({ page }) => {
    await openBuild(page);
    await page.getByText("Approved knowledge", { exact: true }).click();
    await expect(page.getByText(/Add source file/i)).toBeVisible();

    // Upload a plain-text source through the REAL file input (two blocks, unique term).
    const body =
      "Zephyrotest storage overview. Zephyrotest is stored at controlled room temperature according to the approved guidance.\n\n" +
      "Zephyrotest support program. Enrollment support for Zephyrotest is available through the access program in approved materials.";
    await page.getByTestId("upload-source").setInputFiles({ name: "zephyrotest_notes.txt", mimeType: "text/plain", buffer: Buffer.from(body) });
    await expect(page.getByText(/Parsed 2 block\(s\).*review and approve below/i)).toBeVisible({ timeout: 20_000 });

    // The new MLR review queue lists the passages — approve them from the UI. (Scoped by
    // testid: the ISI section has its own Approve buttons, and parallel specs share the server.)
    // Each click refreshes the queue, so a button can vanish mid-loop — tolerate that.
    await expect(page.getByText(/Pending review · \d+ passage/i)).toBeVisible({ timeout: 10_000 });
    for (let i = 0; i < 8 && (await page.getByTestId("mlr-approve").count()) > 0; i++) {
      await page.getByTestId("mlr-approve").first().click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(600); // let the queue refresh settle
    }
    await expect(page.getByTestId("mlr-approve")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText(/Passage approved — it's now live rep knowledge/i)).toBeVisible();

    // Doctor view: the rep answers FROM the uploaded content and the deck shows ITS slide.
    // (Phrased as a public-info question — "how should it be stored?" alone classifies as
    // an UNRECOGNIZED intent and correctly fails safe to the fallback, which is by design.)
    await page.goto("/hcp");
    await page.getByRole("button", { name: /Start session/i }).click();
    const ask = page.getByPlaceholder(/Type or tap the mic|Type, or talk|Ask a question/i);
    await ask.fill("What is the Zephyrotest storage guidance?");
    await ask.press("Enter");
    await expect(page.getByText(/controlled room temperature/i).first()).toBeVisible({ timeout: 20_000 });
    // The uploaded slide joins the on-screen deck (live-deck merge) and gets focused by the cue.
    await expect(page.getByText(/Zephyrotest storage overview/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
