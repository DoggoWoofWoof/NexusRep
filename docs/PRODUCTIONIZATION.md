# NexusRep — Production Readiness

Status of a full read-only audit (2026-07-18). **Bottom line:** the hard part is done — the
compliance engine is genuinely production-grade (fail-safe, single-choke-point final gate on every
turn, ~470 tests incl. red-team) and the vendor-adapter seams are real and swappable. What's left is
conventional web-app hardening around it: **real auth, real persistence, CI, observability.**

## 🔴 Blockers (must fix before real users / real data)

_Progress (2026-07-18): blockers 1, 2, 3, 5 are DONE + verified live; 6 skipped by request; 4 (real
persistence) is the one remaining blocker._

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
4. ⏳ **REMAINING — Real persistence.** On the current deploy `NEXUSREP_DATA_DRIVER=memory` → sessions,
   audit, rules, launch state, follow-ups, CRM outbox, activity log all reset on restart. The advertised
   `DATABASE_URL` → managed-Postgres path is **unbuilt** (`env.databaseUrl` is parsed but unused; the
   "postgres" driver is PGlite-only, which needs ~600 MB / a disk the Starter instance lacks). Two paths:
   **(a)** build a `pg` (node-postgres) adapter selected on `DATABASE_URL` — the scalable answer, but
   needs a provisioned Postgres to develop + validate against (don't ship untested DB code); or **(b)**
   the existing PGlite-on-disk path (`NEXUSREP_DATA_DRIVER=postgres` + `PGLITE_DATA_DIR` + a disk on a
   ≥2 GB instance) — durable but single-instance. Add migrations either way.
5. ✅ **DONE — CI.** `.github/workflows/ci.yml`: `checks` (typecheck + lint + vitest + build) and `e2e`
   (playwright chromium), Node 22.12.0, `NEXUSREP_EMBEDDINGS=lexical` so runners need no model download.
6. ⏭️ **SKIPPED (by request)** — real user store + password hashing + roles. The in-source demo directory
   (`auth-session.ts`) stays for now; Platform Admin + Activity gate on being a signed-in user, not a role.

## 🟠 Important

7. **PII redaction** on inbound HCP text before ANY vendor call (Claude/OpenAI classifier + composer,
   Tavus ASR) — the "no patient-level data to vendors" hard rule is currently comment-only, and a raw
   utterance reaches vendors before the AE router acts. Also make `docnexus.ts` `mapRows` an explicit
   aggregate-only allowlist (today the guarantee is a comment).
8. **Real CRM adapter + scheduled outbox `flush()`.** CRM is always `MockCrmAdapter`; the retry
   `flush()` is never scheduled, so with a real adapter failed deliveries would never retry.
9. **Error tracking + structured logging** (Sentry/JSON logs); stop logging HCP transcript previews to
   stdout (`tavus/llm/.../route.ts`).
10. **Rate limiting** on the public doctor endpoints and the unauthenticated `voice/speak` TTS proxy.
11. **Tavus webhook auth** fails open when the key is unset and passes the key as `?k=` in the URL
    (lands in logs) — require it + move to a header (`tavus/webhook/route.ts`).
12. **Timeouts on `llmComplete`/`llmText`** (composer) — called on the `content/ingest` request path
    with no abort, so a hung LLM call hangs the upload.
13. **Auth/multi-tenancy E2E** — Playwright currently runs with `NEXUSREP_AUTH=0`, so the auth path has
    zero end-to-end coverage.

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
