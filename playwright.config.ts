import { defineConfig, devices } from "@playwright/test";

// Port is env-overridable so E2E doesn't collide with other local dev servers.
const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  // Stable visual snapshots: cap pixel diff tolerance.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
      testIgnore: /rebrand\.spec\.ts|visual-studio\.spec\.ts/,
    },
    {
      // Tests that MUTATE global server state (e.g. the brand name) run AFTER the parallel
      // suite — a rename window mid-run corrupts visual snapshots and brand assertions.
      name: "mutating",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
      testMatch: /rebrand\.spec\.ts|visual-studio\.spec\.ts/,
      // Serial: the studio shots must not race the re-brand mutation.
      fullyParallel: false,
      dependencies: ["chromium"],
    },
  ],
  webServer: {
    // Build + start gives deterministic E2E (no first-hit dev compile races).
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    // Force the deterministic ($0, offline) path for E2E regardless of .env.local —
    // tests must not depend on a real LLM key, network, or token spend.
    env: {
      NEXUSREP_CLASSIFIER: "keyword",
      NEXUSREP_EMBEDDINGS: "lexical",
      NEXUSREP_AUDIENCE: "modeled",
      NEXUSREP_DATA_DRIVER: "memory",
      NEXUSREP_PUBLIC_URL: BASE_URL,
      NEXUSREP_COMPOSE: "deterministic",
      // Seed demo sessions/follow-ups so Sessions / Analytics / Follow-ups (review + metrics)
      // render populated for E2E. In-memory (no data driver) → deterministic, no PGlite.
      NEXUSREP_SEED_HISTORY: "1",
      // Pins the computed "Day N of M" campaign counter so visual baselines are stable.
      NEXUSREP_DEMO_DATE: "2026-07-10",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      THINKING_MACHINES_BASE_URL: "",
      DOCNEXUS_API_KEY: "",
      DOCNEXUS_BEARER_TOKEN: "",
      // No real Tavus in E2E — the A/V spike + video rep must use the mock (no network/credits).
      TAVUS_API_KEY: "",
      TAVUS_REPLICA_ID: "",
    },
  },
});
