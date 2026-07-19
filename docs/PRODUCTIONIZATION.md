# NexusRep — Production Readiness

Status of a full read-only audit (2026-07-18). **Bottom line:** the hard part is done — the
compliance engine is genuinely production-grade (fail-safe, single-choke-point final gate on every
turn, ~490 tests incl. red-team) and the vendor-adapter seams are real and swappable. What's left is
conventional web-app hardening around it. **Update (2026-07-18): blockers 1–5 and the ENTIRE 🟠 Important
tier (7–13) are DONE**, plus the roles half of blocker 6. That covers server-side auth, the
session-secret gate, `/api/activity` gating, managed-Postgres persistence, CI, PII redaction, a real CRM
adapter + scheduled flush, structured logging + error capture, rate limiting (built; shipped OFF pending
session-keying), Tavus webhook auth, LLM timeouts, and auth/multi-tenancy E2E. **Remaining: only the
deferred-by-request real user store + password hashing (rest of #6) and the 🟢 Nice-to-haves** (dead env
switches, security headers, `/api/healthz`, durable activity log, greeting-gate defense-in-depth).

## 🔴 Blockers (must fix before real users / real data)

_Progress (2026-07-18): blockers 1, 2, 3, 4, 5 DONE; 6 PARTIAL (roles done; real user store + password
hashing still deferred)._

1. ✅ **DONE — Server-side auth.** `requireBrandUser()` (`lib/require-auth.ts`) gates every brand-console
   route (studio/sessions/analytics/mlr/followups/integrations/content-*/audience/train-preview/
   activity/presentation-plan/models/arena-stream/setup-chat) — 401 unauthenticated. Uses a shared guard
   (not `middleware.ts`) so the doctor/Tavus/realtime/conversation/recording paths stay open by design.
   Verified live: brand routes 401, open routes 200.
2. ✅ **DONE — `NEXUSREP_SESSION_SECRET` required.** In prod + auth-on, if the secret is the built-in
   default (public/forgeable) the brand API returns **503** and boot logs a loud `[auth] SECURITY …`
   warning (`require-auth.ts`, `instrumentation.ts`, `env.sessionSecretIsDefault`). `render.yaml` sets
   `NEXUSREP_AUTH=1` + declares `NEXUSREP_SESSION_SECRET` (sync:false — **set it in the Render dashboard**).
3. ✅ **DONE — `/api/activity` gated.** Now a gated brand route (401 unauthenticated). The write-only
   client beacon `/api/activity/ingest` stays open by design.
4. ✅ **DONE — Real persistence (managed Postgres).** `DATABASE_URL` now selects a **node-postgres**
   adapter (`lib/db/pg-node.ts`) that points the same `PgRepository` at a hosted Postgres — works on the
   512 MB Starter (no 600 MB PGlite WASM), survives restarts, and is the only path that survives scaling
   past one instance. Precedence: `DATABASE_URL` (node-pg) > `NEXUSREP_DATA_DRIVER=postgres` (PGlite) >
   memory (`makeRepositoryFactory`). Per-user isolation is the same `u_<user>_` table-prefix on one
   shared pool; the in-process Tavus call slot (`lib/active-call.ts`) is untouched. Schema auto-creates
   (`CREATE TABLE IF NOT EXISTS`). **Validated end-to-end** against the real Postgres wire protocol via
   `pglite-socket` (`tests/pg-node-adapter.test.ts`: CRUD, upsert, jsonb filters, append-only, per-user
   isolation) — not mocked. `render.yaml` declares `DATABASE_URL` (sync:false). Still deferred: a formal
   migration tool (lazy `CREATE TABLE IF NOT EXISTS` covers v1) and the embedded-PGlite-on-disk option (b)
   remains available for single-instance deploys.
5. ✅ **DONE — CI.** `.github/workflows/ci.yml`: `checks` (typecheck + lint + vitest + build) and `e2e`
   (playwright chromium), Node 22.12.0, `NEXUSREP_EMBEDDINGS=lexical` so runners need no model download.
6. 🟡 **PARTIAL — roles DONE; user store + hashing still deferred.** Roles now exist: `DemoUser.role`
   (`admin` | `member`), `requireAdminUser()` gates the internal surfaces — Platform Admin
   (`/api/integrations`) and the cross-user Activity monitor (`/api/activity`) return **403** for a
   signed-in non-admin (verified live: 401 unauth / 403 member / 200 admin), and the nav hides them.
   `swastik` is the admin; everyone else is a member. Still deferred: a **real user store** (accounts
   in the DB, not the in-source `auth-session.ts` directory) and **password hashing** (bcrypt/argon2 —
   demo passwords are still plaintext). Those are the remaining slice of #6.

## 🟠 Important

_Progress (2026-07-18): items 7–13 DONE. The entire 🟠 Important tier is complete. Rate limiting (10) is
built + tested but shipped OFF by default (`NEXUSREP_RATELIMIT=1` to enable) until the doctor endpoints
are keyed by session rather than IP — HCPs share IPs (hospital NAT). Remaining work is only the
deferred-by-request user store + password hashing (rest of blocker 6) and the 🟢 Nice-to-haves._

7. ✅ **DONE — PII redaction.** `lib/pii-redact.ts` scrubs identifiers (email/phone/SSN/MRN/DOB/member
   IDs/titled names) at the 4 vendor request builders (Claude+OpenAI classifier + composer); keyword
   classification/retrieval/gate keep full text upstream. `docnexus.ts mapRows` is now an explicit
   aggregate-only allowlist. NOT redacted in our own store/logs (per request). Tavus gets the doctor's
   audio from the CLIENT, so that boundary is client-side (documented).
8. ✅ **DONE — Real CRM adapter + scheduled outbox flush.** `HttpCrmAdapter` (veeva/salesforce → HTTP
   intake) selected on `env.crmAdapter` + `NEXUSREP_CRM_WEBHOOK_URL`; outbox `flush()` (backoff +
   attempt cap → suppress) scheduled in `instrumentation.ts` across every live container's outbox.
9. ✅ **DONE — Error tracking + structured logging.** `lib/logger.ts` (JSON/pretty, level-gated) +
   `lib/error-capture.ts` (global handlers + opt-in sink, no Sentry dep); captureError at the
   orchestrator swallow-points + Tavus route. Per request, HCP transcripts are KEPT in our logs (full,
   not previews) — the vendor rule is enforced by #7, not by redacting our logs.
10. ✅ **DONE — Rate limiting.** `lib/rate-limit.ts` token-bucket on the public doctor endpoints +
    `voice/speak` (IP-keyed) and the Tavus callback (session-keyed high ceiling). `NEXUSREP_RATELIMIT`.
11. ✅ **DONE — Tavus webhook auth.** Fails CLOSED (no key → 401); the callback URL now carries a
    per-owner HMAC signature (`lib/tavus-webhook-auth`) instead of the master key, so the secret never
    lands in access logs; a raw key via header is also accepted. Constant-time compare.
12. ✅ **DONE — LLM helper timeouts.** `llmText`/`llmComplete` (setup inference, rule compaction on the
    `content/ingest` path) now pass `AbortSignal.timeout(env.llmHelperTimeoutMs)` and degrade to null on
    timeout/error instead of hanging the upload.
13. ✅ **DONE — Auth/multi-tenancy E2E.** A second Playwright server (auth ON + a real session secret) +
    an `auth` project (`e2e/auth.spec.ts`): unauthenticated → login/401 + doctor link ungated, member →
    403 on the admin surfaces + nav hidden, admin → 200 + nav visible, bad-creds → 401, and per-user
    isolation (demo user has seeded sessions, clean user is empty). Also pinned `DATABASE_URL=""` in the
    E2E env so the suite is deterministic regardless of a local `.env.local`.

## 🟢 Nice-to-have

14. Remove or implement the dead env switches (`NEXUSREP_VOICE_PROVIDER` / `_AVATAR_PROVIDER` /
    `_CRM_ADAPTER` / `_RETRIEVAL_PROVIDER`, `DATABASE_URL`); document `NEXUSREP_SESSION_SECRET`/`_AUTH`.
15. HTTP security headers (CSP / HSTS / X-Frame-Options) in `next.config`.
16. A cheap `/api/healthz` liveness probe distinct from the heavy `/api/brand` readiness check.
17. Move the activity log to a durable store; surface the silent PGlite→memory fallback as unhealthy.
18. Defense-in-depth: gate the greeting output; use the LLM classifier (not keyword) for the
    presentation-opener pre-screen.

## What is already solid (don't re-litigate)

- **Compliance:** single final gate (`gate.ts`) on every turn via `orchestrator.finalize()`, fail-safe
  to `SAFE_FALLBACK`; approved-content/off-label/AE/ISI-verbatim each enforced AND tested.
- **Vendor seams** are real interfaces resolved through `@modules/vendors`; realtime (Tavus),
  classifiers, composer, embeddings, and DocNexus are genuinely wired (mock fallbacks only).
- **Build is a real gate** (`next build` runs typecheck + lint, no `ignoreBuildErrors`).
- Uploads bounded; recording path-traversal blocked; dev routes disabled in prod.
