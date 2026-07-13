/**
 * Central, typed access to environment configuration. Everything defaults to a
 * fully-mocked, in-memory configuration so the app runs with zero setup.
 */

export type DataDriver = "memory" | "postgres";
export type ClassifierProviderName = "keyword" | "claude" | "openai" | "thinking-machines";
export type RealtimeProviderName = "mock" | "gpt-realtime" | "tavus";
export type VoiceProviderName = "mock" | "whisper-elevenlabs";
export type AvatarProviderName = "mock" | "tavus" | "heygen";
export type CrmAdapterName = "outbox-mock" | "veeva" | "salesforce";
export type RetrievalProviderName = "memory-vector" | "pgvector";
export type AudienceProviderName = "modeled" | "docnexus";

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

const docnexusApiKey = process.env.DOCNEXUS_API_KEY ?? "";
const docnexusBearer = process.env.DOCNEXUS_BEARER_TOKEN ?? "";
const docnexusIdToken = process.env.DOCNEXUS_ID_TOKEN ?? "";
const docnexusPlatformEmail = process.env.DOCNEXUS_PLATFORM_EMAIL ?? "";
const docnexusPlatformPassword = process.env.DOCNEXUS_PLATFORM_PASSWORD ?? "";
const docnexusHasPlatformLogin = Boolean(docnexusPlatformEmail && docnexusPlatformPassword);
// The browserless server path (DEPLOY.md): a long-lived Cognito refresh token + client id.
// Must count as a credential, or a Render deploy configured exactly as documented would
// silently stay on the modeled cohort.
const docnexusHasRefreshLogin = Boolean(process.env.DOCNEXUS_REFRESH_TOKEN && process.env.DOCNEXUS_COGNITO_CLIENT_ID);
const docnexusIdTokenFile = process.env.DOCNEXUS_ID_TOKEN_FILE ?? (docnexusHasPlatformLogin ? ".docnexus-id-token.json" : "");
/** Parse a numeric env var; a malformed value falls back instead of becoming NaN
 *  (NaN reached setTimeout as delay 0 and instantly aborted the claims fetch). */
function numeric(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const tavusApiKey = process.env.TAVUS_API_KEY ?? "";

export const env = {
  dataDriver: pick<DataDriver>(process.env.NEXUSREP_DATA_DRIVER, ["memory", "postgres"], "memory"),
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Off by default: seed 6 fake past sessions + follow-ups so the console isn't
  // empty on a fresh DB. Real usage should leave this off so Sessions/Analytics/
  // Follow-ups reflect only actual conversations. Set NEXUSREP_SEED_HISTORY=1 to demo.
  seedHistory: process.env.NEXUSREP_SEED_HISTORY === "1",
  realtimeProvider: pick<RealtimeProviderName>(
    process.env.NEXUSREP_REALTIME_PROVIDER,
    ["mock", "gpt-realtime", "tavus"],
    tavusApiKey ? "tavus" : "mock",
  ),
  voiceProvider: pick<VoiceProviderName>(
    process.env.NEXUSREP_VOICE_PROVIDER,
    ["mock", "whisper-elevenlabs"],
    "mock",
  ),
  avatarProvider: pick<AvatarProviderName>(
    process.env.NEXUSREP_AVATAR_PROVIDER,
    ["mock", "tavus", "heygen"],
    tavusApiKey ? "tavus" : "mock",
  ),
  crmAdapter: pick<CrmAdapterName>(
    process.env.NEXUSREP_CRM_ADAPTER,
    ["outbox-mock", "veeva", "salesforce"],
    "outbox-mock",
  ),
  retrievalProvider: pick<RetrievalProviderName>(
    process.env.NEXUSREP_RETRIEVAL_PROVIDER,
    ["memory-vector", "pgvector"],
    "memory-vector",
  ),
  // Which LLM provider runs the intent/risk classifier in the live conversation.
  // Defaults to the deterministic keyword classifier ($0, always available).
  // Default to LLM-based routing when a key is present (Claude preferred, then OpenAI) —
  // it reads AE-report-vs-question, comparative-vs-anatomy, and negation far better than the
  // keyword baseline. The keyword classifier stays the offline/e2e fallback and still runs
  // in parallel to contribute deterministic risk floors (mergeWithKeywordSignals). Force it
  // with NEXUSREP_CLASSIFIER=keyword (the e2e suite does, for determinism + zero token cost).
  classifierProvider: pick<ClassifierProviderName>(
    process.env.NEXUSREP_CLASSIFIER,
    ["keyword", "claude", "openai", "thinking-machines"],
    process.env.ANTHROPIC_API_KEY ? "claude" : process.env.OPENAI_API_KEY ? "openai" : "keyword",
  ),
  // How approved answers are composed. "llm" lets a grounded composer rephrase
  // (grounding-validated + gated); "deterministic" speaks approved blocks verbatim.
  // Auto-selects "llm" when a provider key is present (same pattern as Tavus) —
  // set NEXUSREP_COMPOSE=deterministic to force verbatim-only.
  composeMode: pick<"deterministic" | "llm">(
    process.env.NEXUSREP_COMPOSE,
    ["deterministic", "llm"],
    process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ? "llm" : "deterministic",
  ),

  // ── HCP audience source (DocNexus advanced-search) ──────────────────────────
  // Where the targeting cohort comes from. "docnexus" calls the hosted claims
  // backend's POST /api/query; "modeled" uses the built-in cardiology cohort.
  // Defaults to docnexus only when a credential is present, else modeled — so
  // the demo always renders without live infra.
  audienceProvider: pick<AudienceProviderName>(
    process.env.NEXUSREP_AUDIENCE,
    ["modeled", "docnexus"],
    docnexusApiKey || docnexusBearer || docnexusIdToken || docnexusIdTokenFile || docnexusHasPlatformLogin || docnexusHasRefreshLogin ? "docnexus" : "modeled",
  ),
  docnexusBaseUrl: process.env.DOCNEXUS_ADVANCED_SEARCH_URL ?? "https://advanced-search.docnexus.ai",
  docnexusApiKey,
  docnexusIdToken,
  docnexusIdTokenFile,
  docnexusAutoRefreshToken: process.env.DOCNEXUS_AUTO_REFRESH_TOKEN !== "0" && docnexusHasPlatformLogin && Boolean(docnexusIdTokenFile),
  docnexusTokenRefreshScript: process.env.DOCNEXUS_TOKEN_REFRESH_SCRIPT ?? "scripts/docnexus-platform-token.mjs",
  docnexusTokenRefreshTimeoutMs: numeric(process.env.DOCNEXUS_TOKEN_REFRESH_TIMEOUT_MS, 120000),
  docnexusBearer,
  // Claims aggregates can take ~8s; default 20s so real queries don't abort.
  docnexusTimeoutMs: numeric(process.env.DOCNEXUS_TIMEOUT_MS, 20000),
  // Browserless Cognito refresh (server deploys): captured once by the token script.
  docnexusRefreshToken: process.env.DOCNEXUS_REFRESH_TOKEN ?? "",
  docnexusCognitoClientId: process.env.DOCNEXUS_COGNITO_CLIENT_ID ?? "",
  docnexusCognitoRegion: process.env.DOCNEXUS_COGNITO_REGION ?? "",

  // ── Tavus Conversational Video Interface (avatar / realtime) ────────────────
  // Real Tavus CVI lights up when TAVUS_API_KEY is set. The rep's replies are
  // ALWAYS produced by our compliance orchestrator via the custom-LLM layer
  // (Tavus calls our OpenAI-compatible endpoint) — Tavus never free-forms answers.
  tavusApiKey,
  tavusBaseUrl: process.env.TAVUS_BASE_URL ?? "https://tavusapi.com/v2",
  tavusReplicaId: process.env.TAVUS_REPLICA_ID ?? "",
  tavusPersonaId: process.env.TAVUS_PERSONA_ID ?? "",
  /** Shared secret Tavus presents to our custom-LLM endpoint (Authorization: Bearer). */
  tavusLlmKey: process.env.TAVUS_LLM_KEY ?? "",
  /** Publicly-reachable base URL of THIS app (for Tavus custom-LLM + callback). */
  publicBaseUrl: process.env.NEXUSREP_PUBLIC_URL ?? "http://localhost:3000",

  // ── Demo tenant + compliance tunables (nothing behavioral is hardcoded) ──────
  /** The demo/default HCP identity used when no invite-link identity is supplied. */
  demoHcpId: process.env.NEXUSREP_DEMO_HCP_ID ?? "hcp_sharma",
  /** MLR expiry for demo-seeded content. Empty → 18 months from boot. */
  mlrExpiresAt: process.env.NEXUSREP_MLR_EXPIRES_AT ?? "",
  /** Risk threshold at/above which a classified risk routes to a safe path (default 0.6). */
  riskThreshold: clampNum(process.env.NEXUSREP_RISK_THRESHOLD, 0.6, 0.1, 1),
  /** Minimum lexical coverage for an LLM-composed answer to count as grounded (default 0.5). */
  groundingMinCoverage: clampNum(process.env.NEXUSREP_GROUNDING_MIN_COVERAGE, 0.5, 0.1, 1),
  /** Max tokens per composed answer (default 400). */
  composerMaxTokens: Math.round(clampNum(process.env.NEXUSREP_COMPOSER_MAX_TOKENS, 400, 50, 4000)),

  // ── Brand-console auth (multi-user demo directory) ───────────────────────────
  // The gate is ON by default (any deploy asks for sign-in) and only OFF when explicitly
  // disabled with NEXUSREP_AUTH=0 — which the E2E config sets so tests drive the console
  // directly. The user directory + per-user data profile live in auth-session.ts; the doctor
  // link (/hcp) is NEVER gated — doctors reach the rep by link, not by login.
  authEnabled: process.env.NEXUSREP_AUTH !== "0",
  /** Secret for signing the session cookie (stable across restarts so sessions survive). */
  appSessionSecret: process.env.NEXUSREP_SESSION_SECRET || process.env.NEXUSREP_APP_PASSWORD || "nexusrep-demo-session-secret",
} as const;

function clampNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? Math.max(min, Math.min(max, n)) : fallback;
}
