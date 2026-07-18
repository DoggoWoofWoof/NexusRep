# NexusRep — Production Readiness

Status of a full read-only audit (2026-07-18). **Bottom line:** the hard part is done — the
compliance engine is genuinely production-grade (fail-safe, single-choke-point final gate on every
turn, ~470 tests incl. red-team) and the vendor-adapter seams are real and swappable. What's left is
conventional web-app hardening around it: **real auth, real persistence, CI, observability.**

## 🔴 Blockers (must fix before real users / real data)

1. **Server-side auth.** The login is UI-only — `NexusRepApp` conditionally renders the login screen
   and *fails open* on error (`NexusRepApp.tsx`). Brand API routes call `getContainer()` with no
   authorization, so `curl /api/sessions|/api/studio|/api/analytics` returns/mutates brand data
   unauthenticated. Add a `middleware.ts` / shared `requireUser()` that rejects server-side.
2. **Require `NEXUSREP_SESSION_SECRET`** (fail boot if unset in prod) and set it in `render.yaml`. The
   cookie HMAC secret defaults to a hardcoded string (`env.ts`), so every user's cookie is forgeable.
3. **Gate `/api/activity`** — currently an unauthenticated cross-user read of everyone's actions
   (`activity/route.ts`). Behind an admin role.
4. **Real persistence.** On the current deploy `NEXUSREP_DATA_DRIVER=memory` → sessions, audit, rules,
   launch state, follow-ups, CRM outbox, activity log all reset on restart. The advertised
   `DATABASE_URL` → managed-Postgres path is **unbuilt** (`env.databaseUrl` is parsed but unused; the
   "postgres" driver is PGlite-only, which needs ~600 MB / a disk the Starter instance lacks). Build a
   `pg`+pgvector adapter (preferred) or provision a ≥2 GB instance + disk; add migrations.
5. **CI.** No `.github/` at all — nothing runs typecheck/lint/vitest/playwright on PR. Add a workflow.
6. **Real user store + password hashing + roles** to replace the in-source demo directory
   (`auth-session.ts`, plaintext passwords, no bcrypt, `UserData` is a seed profile not a role). Gate
   Platform Admin + the Activity monitor on role.

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
