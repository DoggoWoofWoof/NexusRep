import { defineConfig, devices } from "@playwright/test";

// Port is env-overridable so E2E doesn't collide with other local dev servers.
const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE_URL = `http://localhost:${PORT}`;
// A SECOND server with auth ON, so the auth/roles/multi-tenancy path has real E2E coverage (the main
// suite runs auth OFF to drive the console directly).
const AUTH_PORT = Number(process.env.E2E_AUTH_PORT) || 3101;
const AUTH_BASE_URL = `http://localhost:${AUTH_PORT}`;
const SKIP_WEBSERVER = process.env.E2E_SKIP_WEBSERVER === "1";

// Deterministic ($0, offline) server env shared by both servers — no real LLM key, network, or spend.
const baseServerEnv: Record<string, string> = {
  NEXUSREP_CLASSIFIER: "keyword",
  NEXUSREP_EMBEDDINGS: "lexical",
  NEXUSREP_AUDIENCE: "modeled",
  NEXUSREP_DATA_DRIVER: "memory",
  // Pin the data layer to in-memory: E2E must NOT pick up a DATABASE_URL from a local .env.local (a
  // broken/unreachable Postgres there → node-pg ECONNREFUSED → 500s). Empty wins over .env.local.
  DATABASE_URL: "",
  NEXUSREP_COMPOSE: "deterministic",
  // Seed demo sessions/follow-ups so Sessions / Analytics / Follow-ups render populated for E2E.
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
  // Rate limiting + background CRM flush OFF for E2E.
  NEXUSREP_RATELIMIT: "0",
  NEXUSREP_CRM_FLUSH_INTERVAL_MS: "0",
};

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
      // auth.spec runs against the auth-ON server (own project); keep it out of the auth-OFF suite.
      testIgnore: /rebrand\.spec\.ts|visual-studio\.spec\.ts|auth\.spec\.ts/,
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
    {
      // Auth / roles / multi-tenancy — runs against the auth-ON server (AUTH_BASE_URL).
      name: "auth",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, baseURL: AUTH_BASE_URL },
      testMatch: /auth\.spec\.ts/,
    },
  ],
  webServer: SKIP_WEBSERVER ? undefined : [
    {
      // Build + start gives deterministic E2E (no first-hit dev compile races).
      command: `npm run build && npm run start -- -p ${PORT}`,
      url: BASE_URL,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      // Console auth gate OFF for the main suite — tests drive the console directly.
      env: { ...baseServerEnv, NEXUSREP_PUBLIC_URL: BASE_URL, NEXUSREP_APP_PASSWORD: "", NEXUSREP_AUTH: "0" },
    },
    {
      // Second server, auth ON, for the auth project. `next start` runs NODE_ENV=production, so a real
      // NEXUSREP_SESSION_SECRET is REQUIRED or the brand API 503s (forgeable-default guard) instead of 401.
      command: `npm run build && npm run start -- -p ${AUTH_PORT}`,
      url: AUTH_BASE_URL,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: { ...baseServerEnv, NEXUSREP_PUBLIC_URL: AUTH_BASE_URL, NEXUSREP_AUTH: "1", NEXUSREP_SESSION_SECRET: "e2e-auth-secret" },
    },
  ],
});
