import { expect, test, type Page } from "@playwright/test";

/**
 * NexusRep E2E — the full brand lifecycle + the compliant HCP conversation, driven
 * through the CURRENT UI (unified HCP flow, generalized/self-serve Studio):
 *   Overview/metrics · Setup · Audience · Launch · Sessions/Review · Train/Coach ·
 *   Rules · the A/V spike · and the HCP doctor view (public answer, MSL routing,
 *   off-label refusal, no internal jargon).
 * Visual regression lives in visual.spec.ts.
 */

// Terms a doctor must NEVER see on the HCP-facing view (brief §13). "Test models" is an
// internal brand tool that must be hidden from the shared /hcp link.
const INTERNAL_TERMS = ["MLR", "compliance gate", "CRM", "agent graph", "Platform Admin", "policy router", "Test models", "[object Object]"];

const nav = (page: Page, label: string) => page.locator("aside").getByText(label, { exact: false }).first();

/** Open the HCP conversation (invite → Start session → convo with the ask bar). */
async function startHcpSession(page: Page) {
  await page.goto("/hcp");
  await page.getByRole("button", { name: /Start session/i }).click();
  await expect(page.getByPlaceholder(/Type or tap the mic|Type, or talk|Ask a question/i)).toBeVisible({ timeout: 15_000 });
}
const askBox = (page: Page) => page.getByPlaceholder(/Type or tap the mic|Type, or talk|Ask a question/i);

test.describe("Brand console + metrics", () => {
  test("Overview command center renders, themed, no render errors", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Command Center")).toBeVisible();
    await expect(page.locator("body")).toContainText(/Milvexian/i);
    await expect(page.locator("body")).not.toContainText("[object Object]");
  });

  test("lifecycle nav: AI Rep → Audience → Sessions", async ({ page }) => {
    await page.goto("/");
    await nav(page, "AI Rep").click();
    await expect(page.getByText(/Setup Assistant/i)).toBeVisible();
    await nav(page, "Audience").click();
    await expect(page.getByRole("heading", { name: /Who should the rep speak to/i })).toBeVisible();
    await nav(page, "Sessions").click();
    await expect(page.getByRole("heading", { name: /Who engaged/i })).toBeVisible();
  });

  test("metrics: Analytics + Follow-ups render from seeded state", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Analytics").click();
    await expect(page.getByRole("heading", { name: /Campaign Analytics/i })).toBeVisible();
    await expect(page.getByText(/Opportunity|Sessions|Disclosure|Eligible/i).first()).toBeVisible();
    await nav(page, "Follow-ups").click();
    await expect(page.getByRole("heading", { name: /Who needs follow-up/i })).toBeVisible();
  });
});

test.describe("Setup (chat-configured, self-serve)", () => {
  test("Setup Assistant + content upload control are present", async ({ page }) => {
    await page.goto("/");
    await nav(page, "AI Rep").click();
    await expect(page.getByText(/Setup Assistant/i)).toBeVisible();
    // Expand Approved knowledge -> source library + live rep knowledge controls.
    await page.getByText("Approved knowledge", { exact: true }).click();
    await expect(page.getByText(/Add source file/i)).toBeVisible();
    await expect(page.getByText(/Live rep knowledge ·/i)).toBeVisible();
    await expect(page.getByText(/Source library/i)).toBeVisible();
    await expect(page.getByText(/Required safety information \(ISI\)/i)).toBeVisible();

    const revisedIsi =
      "E2E revised ISI: Milvexian is investigational; safety and efficacy have not been established; direct clinical questions to Medical Information.";
    await page.getByPlaceholder(/Draft revised ISI wording/i).fill(revisedIsi);
    await page.getByRole("button", { name: /Submit revised ISI/i }).click();
    await expect(page.getByText(/Pending ISI v2/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(/Approved\. This exact ISI block is now used live/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Active block v2/i)).toBeVisible();
  });
});

test.describe("A/V spike (Stage 2)", () => {
  test("plays the approved script through the adapters and ends", async ({ page }) => {
    await page.goto("/spike");
    await expect(page.getByRole("heading", { name: /Rehearsal/i })).toBeVisible();
    await page.getByRole("button", { name: /Start rehearsal/i }).click();
    // Brand-driven script: the AI disclosure greeting, then a public-info detail aid.
    await expect(page.getByText(/publicly-available information|AI representative/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Factor XIa|LIBREXIA/i).first()).toBeVisible({ timeout: 30_000 });
    // The scripted A/V walk paces each segment; on the slow CI runner it needs well over the old 20s.
    await expect(page.getByTestId("spike-ended")).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("HCP doctor view", () => {
  test("invite discloses AI + hides internal jargon (incl. the model-test tool)", async ({ page }) => {
    await page.goto("/hcp");
    await expect(page.getByRole("heading", { name: /You're invited to an AI-guided session/i })).toBeVisible();
    await expect(page.getByText(/not a person/i)).toBeVisible();
    await startHcpSession(page);
    const body = (await page.locator("body").textContent()) ?? "";
    for (const term of INTERNAL_TERMS) {
      expect(body, `doctor view must not expose "${term}"`).not.toContain(term);
    }
  });

  test("answers a public product question with the investigational disclosure + ISI", async ({ page }) => {
    await startHcpSession(page);
    // The "Try" chips derive from the live approved knowledge (mechanism topic → this phrasing).
    await page.getByText(/How does Milvexian work/i).first().click();
    await expect(page.getByText(/investigational|Factor XIa|LIBREXIA/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Important Safety Information/i)).toBeVisible();
  });

  test("delivers a slide-led overview using the first-party presentation skill", async ({ page }) => {
    await startHcpSession(page);
    await page.getByRole("button", { name: /Start overview/i }).click();
    await expect(page.getByText(/start the overview|start briefly|Milvexian slide/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Milvexian|Factor XIa/i).first()).toBeVisible();
    await expect(page.getByText(/Mechanism|Factor XIa/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/LIBREXIA|program/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test("routes a clinical-specifics question to Medical Information (never answered)", async ({ page }) => {
    await startHcpSession(page);
    await askBox(page).fill("What is the recommended dose and titration?");
    await askBox(page).press("Enter");
    await expect(page.getByText(/medical information|Medical Science Liaison/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test("refuses an off-label question and offers medical follow-up", async ({ page }) => {
    await startHcpSession(page);
    await askBox(page).fill("Can I use this off-label for pediatric patients?");
    await askBox(page).press("Enter");
    await expect(page.getByText(/outside the approved information/i)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Studio — Train / coach / rules (self-serve)", () => {
  test("Training re-answers the rep from your coaching, and accepting saves a scoped rule", async ({ page }) => {
    await page.goto("/");
    await nav(page, "AI Rep").click();
    await page.getByText("Training", { exact: true }).click();
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByText(/investigational|Factor XIa|LIBREXIA/i).first()).toBeVisible({ timeout: 15_000 });
    // Coach the answer → the rep tries again. The coaching note stays VISIBLE in the thread.
    // (The asked exchange is the LAST one; the seeded greeting exchange is first.) The coach box is
    // COLLAPSED by default (training rework) — click "Coach this line ✎" to reveal the textarea first.
    await page.getByText(/Coach this line/i).last().click();
    await page.getByPlaceholder(/Coach this answer/i).last().fill("Don't mention warfarin.");
    await page.getByRole("button", { name: /Coach & re-answer/i }).last().click();
    await expect(page.getByText(/You coached/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Don't mention warfarin/i).first()).toBeVisible();
    // Accept the answer → the coaching becomes a (compliance-classified) rule. The rules
    // card lives in Pitch & Script / the Rules tab now — assert it landed in Rules.
    await page.getByRole("button", { name: /^Accept/i }).last().click();
    await page.getByText("Rules", { exact: true }).click();
    // The coached rule references the topic ("warfarin") however the compaction phrases it.
    await expect(page.getByText(/warfarin|do not raise|don't mention/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Training push-to-talk applies ASR correction before routing preview answers", async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      window.localStorage.clear();
      type MockSpeechItem = { alternatives?: string[]; text?: string };
      const w = window as typeof window & { __mockSpeechQueue?: MockSpeechItem[] };
      w.__mockSpeechQueue = [];
      class MockSpeechRecognition {
        lang = "en-US";
        interimResults = true;
        continuous = false;
        maxAlternatives = 4;
        onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null = null;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        start() {
          window.setTimeout(() => {
            const item = w.__mockSpeechQueue?.shift() ?? { text: "" };
            const alternatives = (item.alternatives?.length ? item.alternatives : [item.text ?? ""]).filter(Boolean);
            const result = alternatives.map((transcript) => ({ transcript })) as ArrayLike<{ transcript: string }> & { isFinal: boolean };
            result.isFinal = true;
            this.onresult?.({ resultIndex: 0, results: [result] });
            window.setTimeout(() => this.onend?.(), 10);
          }, 30);
        }
        stop() { window.setTimeout(() => this.onend?.(), 0); }
        abort() { window.setTimeout(() => this.onend?.(), 0); }
      }
      Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: MockSpeechRecognition });
      Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: MockSpeechRecognition });
    });

    const speak = async (alternatives: string[]) => {
      await page.evaluate((alts) => {
        const w = window as typeof window & { __mockSpeechQueue?: { alternatives: string[] }[] };
        w.__mockSpeechQueue ??= [];
        w.__mockSpeechQueue.push({ alternatives: alts });
      }, alternatives);
      await page.getByRole("button", { name: "Talk to the rep" }).click();
    };

    await page.goto("/");
    await page.waitForFunction(() => {
      const text = document.body?.innerText ?? "";
      return text.includes("SIGN IN TO CONTINUE") || text.includes("Command Center") || text.includes("AI Rep");
    }, null, { timeout: 45_000 });
    if (await page.getByText("SIGN IN TO CONTINUE").isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.locator("input").nth(0).fill("mahek");
      await page.locator("input").nth(1).fill("mahek123");
      await page.getByRole("button", { name: /Sign In/i }).click();
      await expect(page.locator("aside").getByText("AI Rep", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    }
    await nav(page, "AI Rep").click();
    await page.getByText("Training", { exact: true }).click();
    await expect(page.getByText("Coach the rep").first()).toBeVisible({ timeout: 10_000 });

    await speak(["How does the new vaccine work?", "How does Milvexian work?"]);
    await expect(page.getByText("How does Milvexian work?", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("body")).not.toContainText("How does the new vaccine work?");
    await expect(page.getByText(/Factor XIa|mechanism of action/i).first()).toBeVisible({ timeout: 45_000 });

    await speak(["What is the LEBIREXIA program?", "What is the LIBREXIA program?"]);
    await expect(page.getByText("What is the LIBREXIA program?", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("body")).not.toContainText("LEBIREXIA");
    await expect(page.getByText(/Phase 3|50,000|event-driven/i).first()).toBeVisible({ timeout: 45_000 });

    await speak(["How does it compare to apixaban?"]);
    await expect(page.getByText(/How does it compare to apixaban\??/i).last()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/medical information|Medical Science Liaison/i).first()).toBeVisible({ timeout: 45_000 });

    await speak(["A patient had bleeding while taking the study drug."]);
    await expect(page.getByText("A patient had bleeding while taking the study drug.", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText(/pharmacovigilance|safety team|adverse event/i).first()).toBeVisible({ timeout: 45_000 });
  });

  test("Rules screen shows locked compliance guardrails", async ({ page }) => {
    await page.goto("/");
    await nav(page, "AI Rep").click();
    await page.getByText("Rules", { exact: true }).click();
    await expect(page.getByText(/Refuse off-label/i).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Audience + Review", () => {
  test("Audience shows the live cohort with opportunity scores", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Audience").click();
    await expect(page.getByRole("heading", { name: /Who should the rep speak to/i })).toBeVisible();
    await expect(page.getByText(/Cardiology|Electrophysiology|Interventional|Vascular/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Review opens a session's compliance evidence (real turns + slide)", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Sessions").click();
    await expect(page.getByRole("heading", { name: /Who engaged/i })).toBeVisible();
    await page.getByTestId("review-session").first().click();
    await expect(page.getByText(/session review/i)).toBeVisible({ timeout: 10_000 });
    // Evidence from real turns: the transcript + the approved-source slide the rep showed.
    await expect(page.getByText(/Transcript/i).first()).toBeVisible();
    await expect(page.getByText(/Factor XIa|Mechanism|investigational/i).first()).toBeVisible();
  });

  test("Review → 'Coach this exchange' opens Training with that doctor question pre-asked", async ({ page }) => {
    await page.goto("/");
    await nav(page, "Sessions").click();
    await page.getByTestId("review-session").first().click();
    await expect(page.getByText(/session review/i)).toBeVisible({ timeout: 10_000 });
    const coach = page.getByTestId("coach-exchange");
    // Only sessions with at least one doctor line offer the handoff (honest hide otherwise).
    if (!(await coach.isVisible().catch(() => false))) test.skip(true, "reviewed session has no HCP line to coach");
    await coach.click();
    // Lands on Train with the reviewed question already asked → the rep answers it here.
    await expect(page.getByText("Coach the rep").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/You \(as HCP\)/i).first()).toBeVisible({ timeout: 20_000 });
  });
});

test("agent gallery: browse, filter, select (fixture-backed)", async ({ page }) => {
  // Deterministic vendor catalog; the POST echoes the new selection back the way
  // the real route does, so this exercises the full client wiring.
  const agents = [
    { id: "agent_a", name: "Avery - Office", kind: "stock", status: "ready" },
    { id: "agent_b", name: "Blake - Office", kind: "stock", status: "ready" },
    { id: "agent_c", name: "Casey - Desk", kind: "stock", status: "ready" },
  ];
  let selected: string | null = null;
  let lastSelectBody: Record<string, unknown> | null = null;
  await page.route("**/api/realtime/agents", async (route) => {
    if (route.request().method() === "POST") {
      lastSelectBody = route.request().postDataJSON() as Record<string, unknown>;
      selected = (lastSelectBody.agentId as string) ?? null;
    }
    await route.fulfill({ json: { configured: true, selected, selectedName: null, defaultReplicaId: "agent_a", agents } });
  });
  await page.goto("/");
  await page.locator("aside").getByText("AI Rep", { exact: false }).first().click();
  await page.getByText("Agent", { exact: true }).click();
  await expect(page.getByTestId("agent-card")).toHaveCount(3, { timeout: 15_000 });

  // Search narrows the gallery without scrolling the page.
  await page.getByPlaceholder(/Search agents/).fill("office");
  await expect(page.getByTestId("agent-card")).toHaveCount(2);
  await page.getByPlaceholder(/Search agents/).fill("");

  // Selecting an agent posts the canonical agentId and marks the card in use.
  const casey = page.getByTestId("agent-card").filter({ hasText: "Casey - Desk" });
  await casey.getByRole("button", { name: "Select" }).click();
  await expect(casey.getByText("✓ In use")).toBeVisible({ timeout: 10_000 });
  expect(lastSelectBody).toMatchObject({ action: "select", agentId: "agent_c" });
});
