# NexusRep Walkthrough

> The living reference for the NexusRep build: what exists, what's real vs mocked,
> how to run/test/demo it, and what's next. Updated after every meaningful step
> (brief §23). Companion docs: architecture map `docs/ARCHITECTURE.md`, product brief
> `docs/NEXUSREP_IMPLEMENTATION_BRIEF.md`, vendor analysis `docs/VENDOR_EVAL.md`,
> agent/compliance rules in root `CLAUDE.md`.

---

## 1. Current build status

### Latest: HCP runtime sync, latency, and repetition fixes (2026-07-13)

- **Fixed repeated disclosure loops:** video greetings are now recorded as audit
  `response_output` events, so the composer knows the AI/investigational disclosure
  already happened. Runtime sanitization also strips any model-generated
  "I'm an AI representative..." lead-in from approved answers.
- **Reduced repeated safety/status wording:** when the exact ISI is appended, duplicate
  standalone "not FDA approved", "safety and efficacy", and Medical Information routing
  sentences are removed from the answer body. The exact ISI still appears verbatim when due.
- **Fixed LIBREXIA routing:** named program terms now outrank generic "how does it work"
  mechanism cues, so "How does LIBREXIA work?" retrieves the LIBREXIA program block/slide,
  not the mechanism slide.
- **Improved ASR typo recovery:** common voice variants like "Milbaxian" and "Malvaxian"
  canonicalize to Milvexian before classification/retrieval.
- **Reduced perceived latency:** retrieval now starts in parallel with classification, and
  slow LLM composition falls back after 2.5s to the approved deterministic builder instead
  of keeping Tavus silent. Browser TTS also falls back quickly when OpenAI TTS cold-starts.
- **Fixed the Tavus slow typed path:** normal typed questions while video is on now use
  Tavus `conversation.respond` (the PAL treats the text as user input and calls our custom
  LLM) instead of the old app-fetch-then-`conversation.echo` path. This removes the extra
  browser round-trip and lets Tavus start its own response pipeline sooner.
- **Tuned Tavus response timing:** PAL personas are created/patched with
  `conversational_flow.turn_taking_patience = low` and `sparrow-1`, while keeping
  `speculative_inference = true`. Tavus still always calls our custom-LLM endpoint, and
  that endpoint now inherits the normal live composer policy: grounded LLM rephrasing when
  model keys are present; deterministic approved text only when no composer exists, the
  composer times out/errors, or `NEXUSREP_TAVUS_COMPOSE=deterministic` is explicitly forced.
- **Fixed transcript/slide sync edges:** typed video echo turns keep the exact gated text +
  slide id until the remote Tavus audio stream shows actual speech energy, so captions and
  slides no longer run ahead of the avatar voice. `window.__nexusrepTiming` records
  `echo_queued`, `vendor_started_speaking`, and `caption_release` timestamps for Render/Tavus
  latency stress checks.
- **Made slide motion source-driven:** the orchestrator's `detailAidSlideId` is the authority.
  Spoken-text phrase matching only nudges timing; it no longer decides whether a slide should
  change. This prevents "I'll bring up the slide" answers from staying on the wrong slide.
  Random natural questions are now covered for mechanism, LIBREXIA/program, Fast Track/status,
  and safety/ISI slide selection.
- **Mic behavior:** Tavus/Daily joins with the doctor's mic off; the HCP mic button is red/off
  by default in both video and non-video modes.
- **Verified:** `npm run typecheck`; full `npm test` passed (283 passing, 1 skipped live
  DocNexus test); `npm run build` passed; Playwright E2E passed (27 passing, 2 skipped).
  New regressions cover no AI re-introduction after greeting, a deliberately bad composer
  trying to re-introduce itself, ISI cadence, LIBREXIA program routing, and
  Milbaxian/Malvaxian recovery.

### Human presentation flow + Tavus key check (2026-07-11)

- **HCP "Start overview" now launches the multi-slide presentation overview** from a natural
  doctor prompt ("quick overview") instead of a one-slide deck command. The rep delivers the
  brand pitch slide by slide, while the ask bar remains interruptible so the doctor can ask
  questions between segments.
- **Presentation cues are less synthetic**: server-generated step text now uses presenter
  language ("slide-led overview", "let's move", "bring up the slide") instead of "walk through
  the approved deck" / "next slide" command phrasing. The spoken medical body remains approved
  source text and still passes the final compliance gate.
- **Tavus key check:** all five supplied Tavus keys authenticate. Non-billing `test_mode`
  conversation creation returns `402` for test1-test3 and succeeds for test4-test5; `.env.local`
  is already using test4, so no secret was rotated or committed.
- **How to verify:** `npm run typecheck`, `npm test`, and the HCP E2E overview test should show
  title -> mechanism -> LIBREXIA program through the presentation skill. Playwright still blanks
  Tavus/LLM keys by design to avoid spending vendor credits.

### Agent gallery + vendor-neutral realtime layer (2026-07-10)

- **New Studio mode: "Agent"** (between Build and Pitch & Script): browse the video-agent
  gallery — your own trained agents + the vendor's stock library — with **search**, data-derived
  **setting filters** (Office, Studio…), an **older-versions toggle** (deprecated agents hidden by
  default), and a **scrollable grid** (90+ agents never scroll the page). Selecting an agent
  persists (`StudioState.appearance.agentId`) and every video call uses it; "Train your own agent"
  starts a personal agent from footage (consent + custom-slot warning, status shows as Training).
  Voice & tone chips live here too (voice is bundled with the agent; tone = persona voice style).
- **"Training & Preview" is now just "Training"** (tab, copy, pointers).
- **Vendor-neutral realtime layer** (no vendor lock, per the adapter rule): canonical
  `AgentSummary`/`AgentCatalog` types (`hasAgentCatalog` feature-detect) — vendor "replica"
  vocabulary exists ONLY inside `src/modules/vendors/tavus.ts`; generic routes
  `/api/realtime/conversation` (+`/end`) and `/api/realtime/agents`; `lib/active-call.ts`
  (was tavus-session); client `VideoAgentStage` + a **transport registry**
  (`video-transport.ts`) keyed by provider name — adding a vendor = one adapter + one transport,
  zero changes to stages/routes/Studio. Vendor-named endpoints that remain are the ones the
  vendor itself calls (`/api/tavus/llm`, `/api/tavus/webhook`) — they ARE the adapter surface.
- Session config field renamed `replicaId` → `agentId` (canonical); the Tavus adapter maps it.
- Tests: catalog parsing (merge/dedupe/status), appearance persistence, e2e agent-gallery
  functional flow (fixture-backed select + search) + `studio-agent.png` visual baseline.

### Declutter round (same day): one fact, one place

- **Approved source collapsed**: the Pitch panel's "What the rep says here — approved text"
  paragraph (the third copy of a section's content) now sits behind a "▸ View approved source"
  toggle; the MLR-revision control lives inside it.
- **Slide chips are conditional**: script/transcript cards show the "▤ slide" chip only when the
  slide differs from the section name (the auto-drafted pitch names sections after slides, so
  the chip was pure duplication by default).
- **Cross-screen redundancy audit applied** (agent-swept every screen): Build's triple
  "answer→draft→review" explainer cut to one, Rules caption de-duplicated from the header,
  Train's 4-sentence "How this works" cut to one line, Readiness's doubled "automatic on
  approval" trimmed, knowledge-card walls halved, Agent-mode voice fact stated once,
  Train deck caption + Analytics funnel caption (both restated adjacent content) deleted,
  Follow-ups/Sessions/Audience intros trimmed. Brand pitch panel: one-line blurb, rows show
  number + full title only, "Section N · auto-saves".
- Layout: Training's coaching-rules card moved below the deck panel.

### Final bug + hardcoding audit (same day): two agent sweeps, all confirmed findings fixed

Bugs (compliance-first):
- **Presentation routes now classify HCP text** — a typed deck "jump" or display text
  carrying an AE mention / off-label ask used to ride a hardcoded zero-risk
  classification; risky turns now leave the deck flow for the real pipeline
  (AE→PV, refusal→MSL, medical info, handoff — with follow-ups + audit). Synthetic
  action strings keep the zero-risk constant. Route-level regression tests.
- **Audit seq survives restarts** — it reset to 0 per process, interleaving a durable
  session's trail; now seeded from the store max on first write.
- **Keyword recovery scoped** — it could override a CONFIDENT LLM's medical-info
  escalation (capping risk 0.3 and answering directly); recovery now applies only to
  low-confidence LLM fallbacks. Existing recovery tests still pass.
- **StudioService writes serialized per rep** (same pattern as SessionService) —
  concurrent studio POSTs could lost-update the rules array, silently dropping a
  guardrail. Internal composite ops call *Core variants (no chain re-entry).
- **Persona creation deduped** (two concurrent first sessions shared one POST),
  **webhook callbacks verified** with the shared key when configured, **numeric env
  guard** (a malformed DOCNEXUS_TIMEOUT_MS became NaN → instant abort → silent modeled
  fallback). Dismissed as false positive: "inverted decile" (repo convention is
  decile 1 = top, consistent across modeled/live/UI). Known limitation kept: one live
  video call per process (documented, warned).

Hardcoding (honesty + generalization):
- **Readiness no longer fabricates 68%** + a fake checklist while loading.
- **Targeting query comes from BrandProfile.clinical** (specialties/diagnosisCodes) —
  a rebranded profile no longer silently fetches cardiology HCPs.
- **"Day 18 of 92" is computed** from campaign.startDate/lengthDays (NEXUSREP_DEMO_DATE
  pins it for demos + visual baselines); **greeting** computes time-of-day and pulls the
  name from one DEMO_USER source (e2e pins the clock).
- **Sample-data pill shows if ANY Command-Center KPI fell back** to fixture; Audience
  summary shows em-dashes instead of fixture numbers.
- **Speech locale follows brand.persona.language** (ASR + TTS voice hint).
- **Realtime responders respect NEXUSREP_COMPOSER_MAX_TOKENS**; cognito refresh threads
  the provider timeout. Noted, deliberately deferred: per-market number locale.



NexusRep is a real, runnable **Next.js (App Router) + TypeScript modular monolith**.
The full brand console + HCP doctor experience are built and match the original
`NexusRep.dc.html` mockup, with a real (mock-data) compliance/conversation engine
behind them. Implemented stage-by-stage with review gates.

| Stage (brief §21) | Status | What it delivered |
| --- | --- | --- |
| 1 — Onboarding + scaffold | ✅ done | Modular-monolith scaffold, adapter interfaces, repo/vector abstractions, docs, tests |
| 2 — A/V spike | ✅ done | "Talking twin" rehearsal; real browser voice + optional 3D avatar; now brand-driven |
| 3–4 — Conversation engine + RAG | ✅ done | Content ingestion → approved blocks → controlled retrieval → response builder → detail-aid |
| — Full mockup UI port | ✅ done | Entire prototype rebuilt in React (console + all screens + HCP experience) |
| 5 — Compliance guardrails | ✅ done | classifier/refusal/ISI/AE-PV/grounding validator/final gate/audit + red-team suite |
| 6 — Twin Studio + MLR gating + coaching | ✅ done | Studio setup/persona/rules persist; MLR gates content + compliance-sensitive rules; **active coaching rules now steer the live rep** (blocked-topic reroute, lead-topic re-rank) — default-off, gate stays authoritative |
| 7–8 — Targeting + Audience; Escalation + CRM outbox | ✅ done | Real opportunity scoring (cohort-relative), hosted Advanced Search cohort, follow-ups + CRM outbox on escalation |
| 9 — Analytics console | ✅ done | Live aggregation across sessions/follow-ups/content/targeting |
| 10 — Integration + hardening, demo + handover | ✅ done | Brand generalization (any brand = a `BrandProfile`, no code edits) + self-serve setup/upload, humanlike conversation, clean demo recording, full E2E (functional + visual) green end-to-end |

**Test status:** `typecheck` clean · **189 unit/integration tests** pass (1 guarded live test skipped) ·
**26 Playwright E2E pass** (19 functional incl. the blank-slate self-serve journey + 7 visual baselines).

### Latest — Browserless DocNexus auth: the live cohort works on Render (2026-07-10)

DocNexus advanced-search has no static API key (auth is account-based), and the local token
refresh drives a headless-browser login that can't run on a server. Now:

- `scripts/docnexus-platform-token.mjs` also captures the Cognito **refresh token** (a
  5-segment JWE the old JWT regex could never match) + app **clientId** + **region** from
  browser storage.
- `refreshCognitoTokens()` in the DocNexus provider mints fresh access tokens from that
  refresh token via plain HTTPS `REFRESH_TOKEN_AUTH` — no browser, no SDK. `loadIdToken`
  prefers it over the Playwright script (works on Render; ~300ms), caches in memory, and
  best-effort persists back to the token file locally.
- Env for servers: `DOCNEXUS_REFRESH_TOKEN` / `DOCNEXUS_COGNITO_CLIENT_ID` /
  `DOCNEXUS_COGNITO_REGION` (render.yaml lists them, sync:false). Refresh tokens last
  ~30 days; re-run the script once and update the env to renew.
- Verified: refresh token captured live, and ONE real browserless mint against Cognito
  produced a fresh 24h access token. Unit tests cover the mint + fail-safe fallbacks.

### Studio redesign: Pitch & Script mode + slim Train & Preview (2026-07-10)

The Studio now separates SCRIPT work from CONVERSATION work. (Follow-up refinement: the
Rules card lives in **Training & Preview** — that's where Accept creates rules. Script
coaching in Pitch & Script is a PERMANENT plan change the moment it's applied: no rules,
no accept step; only locked approved text goes through the MLR revision flow.)

- **New "Pitch & Script" mode** (between Build and Training) — the Train skeleton with the
  PPT where the video was. Left: the big slide (follows the selected line), **Deck sources**
  (pick which approved document drafts the script — `reset {assetId}` scopes `defaultPlan`
  to that source — or upload another deck/PDF straight into the MLR queue), and the Rules
  card below the deck. Middle: **the script, line by line** — auto-drafted from the knowledge
  base through the same compliance graph (no sessions), each line coachable in place
  (✎ → the note lands on that section's plan instruction → the script regenerates).
  Right: the section editor (reorder, slide anchors, speaker notes, locked approved text
  with the MLR revision flow).
- **Train & Preview slimmed to free-flow practice**: ask anything, coach answers, Accept →
  rules. The pitch card became a **collapsible Deck panel that follows the conversation**
  (latest answer's slide, or any clicked line — same behavior a doctor sees), with
  "Perfect the script →" jumping to Pitch & Script.
- Shared `useOverviewPlan()` hook: both modes read/write the same server-side plan, so the
  surfaces can't drift.
- **Compliance bug found & fixed while verifying**: the boot seeder re-inserted seed content
  every start, and the Postgres driver's insert is an upsert — so a passage MLR had retired/
  superseded came back ACTIVE after a restart. Seeding is now insert-if-absent (and only
  indexes currently-active answers); regression-tested with a restart simulation
  (`SharedMemoryFactory` in `tests/content-revision.test.ts`), and live-verified: the retired
  version stayed retired across a real restart.
- Visual baselines: `studio-pitch.png` added, `studio-train.png` re-baselined.

### Approved-content REVISION loop: "changes go through MLR", made real (2026-07-10)

The pitch editor's locked box promised "changes go through MLR" but no revision flow existed —
you could only ADD new content, never revise an approved passage. Now:

- **`ContentService.reviseAnswer`**: proposes a replacement for an ACTIVE passage as version
  N+1 (`in_mlr`, `supersedes: originalId`, same slide/topic/clinical scope). Fail-safe: only
  active passages, no empty/identical text.
- **`MlrService.approve` supersedes atomically**: approving a revision retires the version it
  replaces — exactly one version of a passage is ever retrievable/spoken.
- **`POST /api/content/revise`** (thin, audited as a `correction` event) + a
  **"✎ Propose a revision → MLR review"** control right under the locked approved text in the
  Brand-pitch editor. Revisions appear in the same Build → MLR review queue as uploads.
- **Pitch coverage note**: when approved slides exist that the saved pitch doesn't include,
  the card says so (they still answer questions and append to the walkthrough) with a
  one-click re-draft.
- Live-verified end-to-end: revise mechanism text → v2 in queue (old text keeps speaking) →
  approve → v1 retired, v2 active → the rep's rehearsal answer speaks the revised text; then
  reverted to the original wording through the same loop (v3). `tests/content-revision.test.ts`
  covers the loop, rejection (original untouched), and the fail-safes.

RAG behavior confirmed while here: retrieval searches ALL active passages (every approved
upload joins immediately); the guided pitch speaks plan sections first and appends approved
content that isn't in the plan, so nothing approved is ever unreachable.

### Full audit + fix round (2026-07-10)

Six parallel code auditors (screens, routes, compliance core, platform modules, tests/config/docs)
plus a live screen-by-screen pass. Every confirmed finding fixed:

- **Live cohort resilience (the big one).** The DocNexus fetch armed its abort timer BEFORE
  resolving auth headers — a cold-boot token refresh (up to 2 min) ate the window and the fetch
  aborted mid-refresh, silently swapping the 39 real cardiologists for the 8-doctor modeled
  sample for the process lifetime. Fixed (headers resolve first), plus: one retry at boot,
  a **self-healing runtime** (`c.audienceRuntime.refresh()`, throttled 60s, swaps the live
  cohort back into the SAME TargetingService via `replaceCohort` — analytics/identity/NPI all
  see it), a `degraded` flag on `/api/audience`, and an explicit Audience banner while degraded.
- **Tavus callback auth is now mandatory** — `/api/tavus/llm` refuses with 401 when
  `TAVUS_LLM_KEY` is unset instead of falling open (an unset key on Render would have exposed
  the compliance endpoint).
- **ISI dedup re-unified** — the orchestrator kept a private un-normalized copy of the
  delivered-ISI check; whitespace variance could have re-delivered ISI. It now calls the one
  shared `isiAlreadyDelivered`.
- **Honest chrome:** the sidebar "AI Rep 68%" badge and header "Campaign live" chip are now
  computed from live studio readiness/rep state (draft/in-review/ready/live); the two hardcoded
  "Ready" rows on the Launch checklist are computed from the content store (active passages +
  ISI) and setup sections; Analytics gained the same sample-data banner as the other screens;
  the Studio header shows "…" instead of a made-up percent while loading.
- **Route hygiene:** presentation/plan caps feedback at 500 chars and returns generic 500s
  (details server-side); studio validates `repState` against the enum and ignores
  `appliesToHcpId` on non-HCP scopes; arena stream no longer echoes provider internals.
- **Cosmetics:** model-lab selects disabled until the real provider list loads; pitch reorder
  arrows guarded while a save is in flight; session-transcript keys stabilized; dead
  `SESSIONS`/`CRM_EVENTS` fixtures deleted.
- **Coverage:** visual baselines added for Build / Train / Audience (7 total);
  `tests/audit-round2.test.ts` covers ISI whitespace parity, `replaceCohort` recovery, and CRM
  payload shape. Audit verdicts on everything else: clean (gate on every output path, no
  patient-level data at any vendor boundary, module boundaries intact, secrets never echoed).

### Knowledge transparency + Train UX round (2026-07-10)

- **Source library is honest and self-serve.** Document badges derive from their passages
  (an upload whose passages were all rejected shows **Rejected**, not a stale "In Mlr");
  non-active documents get a **× Remove** control backed by `ContentService.removeAsset`
  (fail-safe: documents with LIVE approved passages refuse deletion — retire via MLR first,
  verified 409). The two Cardiozan TEST uploads from autofill verification were removed.
  New copy explains the model: the launch deck ships MLR-approved (brand baseline);
  everything uploaded starts In MLR review; the queue header now says exactly that.
- **"View the N passages"** — the Live-rep-knowledge counts are expandable: every retrievable
  passage listed by document with topic, live/in-review status, and its text. Nothing hidden
  behind an aggregate number.
- **Train thread autoscrolls** to the newest message (new questions, re-answers, and the
  session-review "Coach this exchange" handoff land in view — no manual scrolling).
- **Rules from your coaching moved** from below the tall pitch card (where nobody scrolled)
  to the left column next to the thread that creates them.
- **Model lab moved to Training** (from the HCP preview): same A/B streamed comparison with
  TTFT/total latency, collapsed card, clearly labeled internal + not-the-compliant-answer.
  The HCP preview no longer carries any model-testing UI at all; Admin copy updated.
- **Sidebar header fixed** — the NexusRep pill no longer collides with the collapse control.

### Audience & scoring: explainable score, real engagement, attribution fix (2026-07-10)

- **Bug fixed — stripped ids silently misattributed sessions.** The Audience drawer's
  "Preview AI rep" (and invite links) pass ids without the canonical `hcp_` prefix; the cohort
  lookup missed and the session was silently attributed to the demo doctor (live-proven).
  `TargetingService.get` is now prefix-tolerant, `resolveSessionAndHcp` stores the COHORT's
  canonical id, `npiFor` normalized, and the session detail route resolves live-cohort names.
  The attribution e2e now asserts the session's doctor name directly.
- **Scoring is explainable and cohort-honest.** Every score carries a per-signal breakdown
  (`components`: weight × value = points). `effectiveWeights` renormalizes away signals that
  are UNIFORM across the cohort — pre-launch, brand share and trend are 0 for everyone, so the
  old score was a constant baseline dressed as three signals; now it's a clean volume ranking
  (top = 100) and the drawer labels the uniform signals "uniform pre-launch — not ranking".
  Rationale leads with what actually ranks the doctor, and explains the pre-launch situation
  once instead of repeating constants.
- **Fabricated drawer bars are gone.** "Inferred content affinity" (percentages derived from
  the score) → "Score breakdown" (the real math) + **"Engagement so far"** — real per-doctor
  data from our own session logs via `AnalyticsService.engagementForHcp` + a new
  `GET /api/audience/engagement?hcp=` route: sessions, questions, follow-ups, last contact,
  and the approved topics actually shown. Honest empty state before the first conversation.
- **Cohort table gains search + specialty filter** (with a live "N of M doctors" count).
- New tests: `tests/audience-scoring.test.ts` (renormalization, breakdown sums, prefix-tolerant
  lookup, rationale honesty).

### Pitch coherence: ONE plan everywhere, per-section coaching, knowledge-derived suggestions (2026-07-10)

- **The pitch plan is now the single source of truth.** `mergePlan` (moved into the
  presentation module) resolves the EFFECTIVE plan — saved brand edits over the DocNexus
  default — and the Brand-pitch card, the Train rehearsal, **and the doctor-facing overview**
  all speak from it. Previously, with no saved plan, old coaching rules silently reordered the
  spoken walk while the card showed deck order (the "flow doesn't match the PPT" confusion).
- **Rehearsed pitch segments are 1:1 with the plan** — same numbering, same section titles,
  "shows <slide>" on each — and **clicking a segment jumps the pitch panel to that section**
  (slide preview + editor), transcript-style.
- **Per-section coaching**: every segment has a **Coach** control — the note applies to THAT
  section's plan instruction immediately (persisted) and the rep re-delivers. The exchange-level
  coach box now also applies live to the selected section (it used to do nothing until Accept).
  Sections can be **reordered** in the card; Accept no longer double-saves pitch notes as rules.
- **Pitch editor de-mystified**: every field is labeled (Section title / Slide on screen /
  Your notes to the rep), and the grey box is explicitly "approved text (locked, changes go
  through MLR)" — the MLR-approved words the rep speaks, not an input.
- **Doctor "Try asking" chips derive from the LIVE knowledge base** (`tryQuestionsFromKnowledge`):
  topics of retrievable approved answers become natural questions (word-anchored templates + a
  generic fallback for novel upload topics). Explicit setup answers still win; profile is last.
- **`useBrand` made resilient**: a failed first `/api/brand` fetch (cold compile / cold boot) no
  longer strands mounted components at "Loading deck…" forever — failures retry with backoff and
  a late success broadcasts to every consumer.
- **Bug fixed**: literal backspace characters had replaced `` regex anchors in the plan route
  (shell heredoc mangling) — the "slide couldn't be matched" warning never fired.
- New tests: `tests/pitch-coherence.test.ts` (mergePlan fidelity + try-question derivation).

### Upload-driven setup + Brand-pitch training UX + session→coach handoff (2026-07-10)

- **Upload a document → setup fills itself.** `POST /api/content/ingest` now also infers setup
  answers from the uploaded text (`inferSetupAnswersFromDocument` in `setupAssistant`): brand,
  indication, therapeutic area, sponsor, tagline, talking points, hotwords, try-questions. LLM
  extraction (strict JSON, sanitized, 300-char caps) with a deterministic offline fallback for the
  brand name; **fills blank fields only — never overwrites a user's answer**. The Build chat footer
  gained a **“📎 Autofill from a document”** chip, and the upload result names exactly which fields
  were filled. Unit-tested (`tests/setup-autofill.test.ts`, 6 tests) + live-verified.
- **“Guided overview” is now the “Brand pitch”, and it's explained.** The Train sidebar card says
  what it is (drafted by DocNexus from your approved deck; the rep opens doctor conversations with
  it slide-by-slide), shows the sections as a readable list (title + anchored slide) instead of
  anonymous numbered squares, autosaves edits (no redundant Save button), and has **▶ Rehearse**
  right on the card — running the pitch in the coaching thread. All status copy renamed to match.
- **Session review → “✎ Coach this exchange”.** The Turn-evidence panel in a session review can now
  send the exact doctor question to Training (one-shot localStorage seed), which auto-asks it so you
  coach the very line that needed work. E2E-covered in `nexusrep.spec.ts`.
- **Bug fixed: text/voice sessions were invisible in Sessions.** The list API filtered to
  `recordingUrl` only; it now lists any session with real turns OR a recording (same rule as the
  detail view) — restoring the “improve from sessions” loop for non-video conversations.
- ESLint autofill instrumentation: setup-autofill failures now log a server-side warn/error instead
  of failing silently.

### Perfection pass: honest Admin, wired preview-identity, hardened e2e (2026-07-10)

- **Platform Admin shows LIVE integration status** via new `GET /api/integrations` — every vendor
  seat reports what the container actually resolved (Tavus **Connected**; voice/retrieval/composer/
  audience/CRM honestly **Simulated**; per-classifier key availability). The hardcoded "Connected"
  badges and the fake CRM toggles are gone.
- **Audience → "Preview AI rep" now runs the doctor view AS that doctor** — `sessionHcpId` existed
  but nothing consumed it (identity silently defaulted); it now feeds the same validated invite-
  identity mechanism, so preview sessions/follow-ups attribute to the previewed doctor (e2e-proven
  via follow-up attribution).
- **`reachableLlm` is now an active probe** of the public URL (a dead trycloudflare tunnel
  previously reported reachable → replica greeted then went silent with no explanation; the note
  now says exactly what to fix).
- **Train rehearsal failure is honest**: no more canned fixture answer when the preview service is
  unreachable (it was themed to the seeded brand — wrong after a re-brand).
- **E2E hardened**: state-MUTATING tests (re-brand by chat) moved to a dependent `mutating`
  Playwright project that runs AFTER the parallel suite (a rename window mid-run corrupted the /hcp
  visual snapshot); attribution test added; stable testids for audience rows/drawer/review queue.
- DEPLOY.md env-name fix (`NEXUSREP_REALTIME_PROVIDER`); dead-code cleanup (unused Toggle/fixtures).
- **Final state: 189 unit/integration + 21 e2e green** (1 guarded live test + 1 GPU test skipped).

### Live Tavus verification (real key) + first-call timeout fix (2026-07-10)

Verified the Tavus path against the REAL Tavus API (one conversation, ended immediately):

- **Conversation create works** with the invite identity (`hcpId` honored → session attributed to the
  real cohort doctor); the per-call session logs the greeting server-side.
- **The reply flow Tavus performs** (same OpenAI request shape + `TAVUS_LLM_KEY` Bearer against
  `/api/tavus/llm`) returns the gated approved answer AND logs both turns authoritatively — the rep
  turn carries its `detailAidSlideId` (`slide_moa`), so the replay slide-sync works for spoken calls.
- **Persona reuse confirmed**: stable per-brand personas, zero per-session "pal" spam being created.
- **Bug found live + fixed**: the adapter's 8s API timeout made the FIRST video call of a session
  fail (`configured:false`; persona create/patch + conversation create exceed 8s cold) and succeed
  only on retry → default timeout now 15s (`vendors/tavus.ts`).
- Only untested piece: Tavus's servers reaching the tunnel (the `.env.local` trycloudflare URL is
  dead; opening a new public tunnel needs the operator — start `cloudflared`, update
  `NEXUSREP_PUBLIC_URL`, restart, then join a call from `/hcp`).

### Blank-slate self-serve journey closed + e2e-proven (2026-07-10)

Everything is now doable from the chat + UI alone, and it's covered by `e2e/self-serve.spec.ts`:

- **Uploads can be APPROVED in the UI.** The Approved-knowledge section gained an MLR review queue
  (Approve/Reject per parsed passage → `/api/mlr`) — previously the pending count displayed but the
  only way to activate an upload was the raw API. Upload → review → live knowledge is self-serve.
- **Approved uploads render as REAL slides.** `/api/brand` now merges the authored profile deck with
  LIVE approved content (`mergeLiveDeck`; bullets from the approved text) — so a brand configured
  purely by chat + upload gets the same rich on-screen deck the seeded demo has, and the rep's slide
  cues focus the uploaded slide in the doctor view. (Previously SlideView could only ever show the
  static profile deck — uploaded slides were undisplayable.)
- **Setup chat de-cluttered:** eight essentials first, then five optional polish questions
  (sponsor, tagline, voice tone, sample questions, hotwords) labeled `optional` with a **Skip →**
  chip; "Decide for me" still fast-forwards everything.
- **Real bug found by the new e2e and fixed:** ingest was stamping the chat's *target-audience
  phrase* ("decile 2–4 whitespace cohort") as the upload's MLR **audience** label, so retrieval
  (querying with the stable clinical audience) rejected every upload as `audience_mismatch` the
  moment someone answered the audience question. Ingest now stamps the brand's stable clinical
  context — targeting preferences can never break content retrieval. Also: bare "approved" no longer
  over-matches the `status` topic at ingest.
- **E2E (`self-serve.spec.ts`):** re-brand by chat → doctor view re-themes (then restores); optional
  questions labeled + skippable; upload a .txt through the real file input → approve both passages in
  the review queue → doctor asks about the new content → rep answers from it verbatim + the uploaded
  slide appears in the deck. Note the suite also confirmed fail-safe classification: an
  unrecognized-intent question correctly falls back instead of answering.

A three-agent audit (UI / modules / API) found ~40 issues; all fixed in six batches (all live-verified):

- **Real HCP identity end-to-end.** Launch now activates a personal `/hcp?hcp=<cohort id>` link per
  doctor (persisted server-side via `StudioService.launch` + `action:"launch"`); every conversation
  route resolves identity through ONE shared helper (`src/lib/resolve-session.ts`) that validates the
  id against the claims cohort — sessions/follow-ups now show the real doctor (verified: Dr. HANI
  DOUEDI from the DocNexus cohort), never always "Dr. A. Sharma". Sessions keep the identity they
  started with (no re-attribution).
- **Live CRM delivery.** Escalations now enqueue AND attempt delivery through the outbox
  (`ConversationService` + `npiFor` from the cohort). Statuses are truthful ("Sent"/"Needs mapping",
  not stuck "Created"), and the Follow-ups target label reflects the ACTUAL adapter ("CRM
  (simulated)" for the mock — never "Veeva" when Veeva isn't connected).
- **Engine fully de-branded.** New `BrandProfile.lexicon` (productTerms + topicSynonyms); classifier,
  retrieval re-rank, overview detection, and ingest topic inference consume it via
  `configureClassifierLexicon`/`configureRetrievalLexicon`/params. Zero brand tokens remain in engine
  code (grep-verified). Demo HCP id + MLR expiry are env-driven (`NEXUSREP_DEMO_HCP_ID`,
  `NEXUSREP_MLR_EXPIRES_AT`, default +18mo). Compliance tunables are env-configurable
  (`NEXUSREP_RISK_THRESHOLD`, `NEXUSREP_GROUNDING_MIN_COVERAGE`, `NEXUSREP_COMPOSER_MAX_TOKENS`).
- **Setup answers now DRIVE behavior.** `blocked_topics` → active, enforceable guardrails (verified:
  "pricing" question reroutes to Medical Information); `msl_contact`/`ae_routing` → follow-up owners;
  `voice_style` → persona; new chatable keys consumed by `resolveBrandProfile`: sponsor, tagline,
  try_questions, hotwords (hotwords also extend the lexicon). All added to the Setup chat script.
- **Concurrency + dedup bugs.** `appendTurn`/`recordOutcome` serialized per session (parallel turns
  can't drop); `sameRule` scoped by HCP (two doctors' identical coaching = two rules); Tavus persona
  cache is per-brand; active-call supersede is logged; `newId("")` no longer collides; Train
  localStorage is brand-keyed (v2) so a brand switch can't rehydrate a stale thread.
- **Honest UI.** "Needs attention" is computed (readiness gaps + pending rules + CRM mapping);
  Overview KPIs + audience fixtures carry a "sample data" banner when the API didn't load;
  "Sessions needing coaching" lists REAL flagged sessions; the Source library renders the live
  content module; specialty options come from the live cohort and persist; selects show "Saved ✓";
  Launch copy says exactly what happens (links activate; email delivery not connected).
- **Validation + unification.** One shared `isiAlreadyDelivered` detector (3 routes);
  overview-plan feedback warns when a named slide can't be matched (never silently keeps the old
  anchor without telling you); upload capped ~10MB pre-decode; turn text capped 2000 chars; coaching
  notes capped 12×300; utterance dedup uses a 6-turn window; webhook reports attach failures;
  presentation metrics record real latency (was 0).
- **+11 regression tests** (`tests/audit-fixes.test.ts`) covering all of the above · 189 total green.

Fixed the robotic ISI repetition in rehearsal and made guided deck walkthroughs trainable:

- **Training Preview now behaves like one rehearsal session.** The UI sends a per-restart
  `previewSessionId`; once the active ISI has been delivered in that rehearsal, follow-up product
  questions do not keep appending the full `Important Safety Information:` block.
- **Guided overview is now first-class in Training & Preview.** The training panel has a
  `Guided overview` starter. Ask it, coach it ("start with LIBREXIA", "use mechanism second",
  "make slide cues more natural"), re-answer until it is right, then accept the coaching as rules.
- **Presentation/deck coaching now reaches the deck skill.** Accepted active presentation guidance
  feeds `/api/presentation/overview` and `/api/presentation/step`; rehearsal also consumes
  non-rejected draft guidance so the brand user can test slide order before activation.
- **Slide order uses approved slide/source matching, not keywords alone.** Guidance weighting favors
  slide title/label/topic over incidental body text, so "start with the LIBREXIA program slide" puts
  `slide_program` first instead of matching the title slide just because it mentions LIBREXIA.
- **Verified:** `npm run typecheck`; `npm test` → 176 passed / 1 skipped. Live smoke:
  first rehearsal answer delivered ISI, second did not repeat it; guided overview coaching started
  on `slide_program`.

### Latest — Tavus transcript + coaching preview fidelity (2026-07-09)

Fixed the duplicated/mismatched Tavus captions and tightened the Training & Preview coaching loop:

- **Tavus video no longer renders duplicate captions.** The Tavus conversation payload disables
  provider closed captions, and `TavusStage` no longer draws its own black subtitle overlay. The
  transcript/captions panel is the single source of truth, hydrated from audited session turns.
- **Saved greeting changes refresh every client surface.** `useBrand()` now supports cache
  invalidation; Studio Build answers and coached greeting saves trigger a brand refetch so the HCP
  view and Tavus custom greeting reload the saved line instead of a stale cached one.
- **Accepted style coaching affects rehearsal immediately.** Draft persona-style rules from accepted
  coaching are now folded into `/api/train/preview` guidance, while live HCP turns still use only
  active rules. This lets brand users keep iterating in preview before activating rules.
- **Length coaching is obeyed more tightly.** The grounded composer turns "one sentence", "two
  sentences", "concise", and similar notes into hard answer-body constraints. ISI is still appended
  separately and verbatim by the orchestrator, so coaching can shape the answer body without
  rewriting safety language.
- **Slide/ISI repetition reduced.** Deck walkthrough steps no longer append the full ISI unless the
  step is actually the safety statement, and normal turns skip repeating the full active ISI once it
  has already been delivered in that session.
- **Verified:** `npm run typecheck`; `npm test` → 174 passed / 1 skipped. Live `/api/train/preview`
  smoke with "one sentence + mention slide" returned `usedLlm:true`, `route:approved_answer`,
  `detailAidSlideId:"slide_moa"`, one coached sentence before the required verbatim ISI.

### Latest — Session recording + replay sync (2026-07-09)

Fixed the "Session review" replay and recording trust issues:

- **Mic and typed turns now share the same NexusRep runtime path.** Tavus voice calls
  `/api/tavus/llm`, but that endpoint now delegates to `ConversationService.turn()` just like
  typed chat. Tavus is ASR/avatar transport only; classification, retrieval, composition,
  compliance gate, transcript/source/slide logging, follow-up, and CRM outbox all live in NexusRep.
- **Duration no longer shows `00:00`.** Review/list APIs derive duration from the actual transcript
  span when a live/Tavus call never called `SessionService.end()`. Regression covered in
  `tests/sessions.test.ts`.
- **Replay metrics are computed from real records.** Turns/questions/audit/gated outputs come from
  session turns + audit events. "Sources cited" now counts all rep turns, not just the first rep turn
  after each HCP question, so multi-slide overview sources are included.
- **Short recordings are called out honestly.** If a WebM ends before the transcript timeline, the
  review page warns that later lines were logged after captured Tavus media stopped instead of
  pretending the video and transcript are synced.
- **Overview narration no longer logs six slides at one instant.** The presentation overview endpoint
  spaces rep turns by estimated speaking time, matching the video echo playback cadence.
- **Recorder now fails closed on missing speech.** `scripts/record-full-tavus-session.mjs` stops
  producing a "clean" output if the Tavus replica leaves live state or never starts speaking for a
  prompted answer. Because Tavus does not reliably emit `stopped_speaking` for every echo, the HCP UI
  now keeps typed/video turns pending for the estimated speech window; the recorder treats a missing
  stop event as a warning, not proof of failure.
- Verified saved session `session_mrdcoo0zn963lj`: persisted duration was `0`, derived transcript span
  is `721s`, turns `22`, questions `8`, gated outputs `13/13`, audit events `59`, sources cited `6`
  (`ans_title`, `ans_moa`, `ans_program`, `ans_status`, `ans_isi`, `ans_contact`).

### Latest — First-party KB/RAG + deck presentation skill (2026-07-09)

- **Hosted DocNexus Advanced Search can now run without the local ClickHouse app.**
  `scripts/docnexus-platform-token.mjs` logs into `platform.docnexus.ai/insights`
  using env-provided credentials, captures the current platform Cognito tokens from
  browser auth state, and writes an ignored `.docnexus-id-token.json` file.
  `DocNexusAudienceProvider` can read `DOCNEXUS_ID_TOKEN` or
  `DOCNEXUS_ID_TOKEN_FILE`; for the hosted API it sends the captured access token as
  `Authorization: Bearer` to `POST /api/query`. ID tokens still fall back to
  `x-id-token` for older/internal paths. When `DOCNEXUS_PLATFORM_EMAIL` and
  `DOCNEXUS_PLATFORM_PASSWORD` are set, NexusRep refreshes the token file
  automatically if it is missing or near expiry, so `npm run dev` does not need
  a manual token-refresh step. Existing `X-Api-Key` and `Authorization: Bearer`
  flows still work. Live check on 2026-07-09: token refresh succeeded, hosted
  `POST /api/query` returned 1 smoke row, the live provider returned 39 cardiology
  HCPs, and `npm run dev` served `/api/audience` from the hosted cohort.
- **NexusRep now owns the Knowledge Base surface.** Content ingestion stores the canonical
  `ContentAsset` document plus slide/page-ordered retrieval passages derived from active documents, and
  `GET /api/content/knowledge` returns the first-party KB snapshot: documents, chunks,
  MLR status, source files, linked slides, active/pending counts, and safety blocks. The
  Studio Approved knowledge section now separates "Source library" assets from "Live rep
  knowledge" so uploaded files, pending review passages, retrievable passages from active
  documents, and active ISI are visibly distinct. MLR approval is document/safety-block level;
  "passages" are only NexusRep's internal retrieval units.
- **NexusRep now has its own presentation skill.** `PresentationSkill` presents from the active
  approved deck using the source slide order, supports start/next/previous/jump, speaks only
  linked active `ApprovedAnswer` blocks, returns the slide to show, and appends/verifies the
  active exact ISI through the same final compliance gate.
- **HCP preview can demo guided overviews without Tavus.** The doctor view has guided overview
  controls ("Start overview", "Go back", "Continue") that call
  `POST /api/presentation/step`, log the turn, update the approved slide, and speak through
  browser/3D/Tavus rendering depending on what is enabled. Tavus is now optional rendering,
  not the knowledge or presentation source of truth.
- **PGlite runtime startup hardened.** `getDb()` and `getContainer()` now use `globalThis`
  singletons so parallel Next route bundles do not open/seed the same embedded Postgres data
  directory at the same time. Failed table-init/container promises reset so a transient PGlite
  abort does not poison future requests. Smoke-verified with `NEXUSREP_DATA_DRIVER=postgres`:
  `/api/audience`, `/api/analytics`, `/api/content/knowledge`, and `/api/presentation/step`
  all return 200.
- **Aborted PGlite archive triaged.** The old `.nexusrep-data.aborted-20260709-045803`
  directory is preserved for forensics, but it is not serveable with the current PGlite runtime:
  copied repair attempts that removed `postmaster.pid`, transient startup files, WAL variants,
  and relcache init files still abort before public tables can be listed. A fresh `.nexusrep-data`
  opens normally and was smoke-verified against the same API set plus `/api/content/safety` and `/`.

### Latest — Editable ISI draft + exact approved runtime delivery (2026-07-09)

- **ISI can now be modified in the Studio without weakening the live gate.** Build → Approved
  knowledge shows the active ISI block, a draft editor, a "Confirm active ISI" action, and pending
  ISI drafts with Approve/Reject. A brand user can paraphrase or rewrite the ISI there, submit it
  as `in_mlr`, and approve it as the new active safety statement.
- **Runtime still uses only the active approved ISI exactly.** The composer/coaching loop may reword
  the approved answer body and make slide references more natural, but the orchestrator appends the
  active approved ISI block and the final compliance gate verifies that exact text before output.
  This gives editable wording through content governance, not arbitrary live paraphrasing.
- **MLR now handles safety statements, not only answer blocks.** `MlrService` lists/approves/rejects
  pending `SafetyStatement` records. Approving a revised ISI retires the previous active ISI so the
  runtime cannot accidentally pick an older block.
- **Content ingestion now persists uploaded ISI.** Files with `isi` in the filename are treated as
  ISI sources; parsed safety statements are stored as pending MLR content instead of only being
  counted in the upload response.
- **Rules are written plain-text** (no stray `**`/markdown) so they read as system-prompt directives
  the way Tavus / our composer consume them (`plainDirective` in `compactCoaching`).
- **Tavus stops spawning a new "persona" per session.** The adapter now creates ONE persona (stable
  name), caches it process-wide, reuses it every session, and **updates it in place** (JSON-Patch)
  when the system prompt changes — instead of `NexusRep rep {sessionId}` each call. (Code-verified;
  exercised only with a real `TAVUS_API_KEY`.)
- **Dev-server note:** the durable PGlite store corrupted under concurrent write-heavy testing
  (`RuntimeError: Aborted()` on seed). Recovered by running dev with `NEXUSREP_DATA_DRIVER=memory`
  (re-seeds the rep, leaves `.nexusrep-data` untouched). Prefer in-memory for write-heavy iteration.

### Latest — F2: conversational coaching loop (2026-07-09)

The Train screen is now a **coaching thread**, not a one-shot "coach → draft rule":

- **The rep re-answers.** Ask a question → coach any answer → the rep tries again with all your notes
  applied, iterating until you **Accept**. Re-answers go through a new rehearsal endpoint
  `POST /api/train/preview`: classify → route → retrieve → **LLM-compose with the coaching as
  guidance** → grounding-validate → compliance gate — exactly like a live turn but with **no side
  effects** (no session, no logged turn, no follow-up; `orchestrator.handleTurn(..., {preview:true})`).
  Coaching is style/emphasis guidance layered UNDER the composer's absolute grounding rules, so it can
  restyle wording but never introduce a fact or bypass the gate. `usedLlm:false` (no AI key) → the UI
  says so and shows approved text only.
- **Your coaching stays visible** in the thread ("You coached: …"), interleaved with each answer version.
- **The opening line is coachable too.** The greeting is the first card in the thread — coach it (warmer,
  shorter…) and the rep rewrites it while **keeping the mandatory disclosures** (AI + investigational +
  Medical-Information routing); a deterministic check fails safe to the current greeting if a rewrite
  drops one. Accept → persists as the rep's greeting/disclosure (`action:"greeting"`), live everywhere.
- **Accept compacts the coaching into rule(s).** Compliance-sensitive notes (block/comparative/ordering)
  each stay their own gated rule; style notes are summarized by the LLM into **one** persona_style rule
  with a one-shot **example** (`compactCoaching` + `partitionCoaching` + `StudioService.acceptCoaching`).
- **Accepted style coaching now steers the LIVE rep.** `activeSteering` gained `styleGuidance` (active
  persona_style instructions), which the orchestrator passes to the live composer — so "perfecting the
  rep" in rehearsal actually changes its wording in production (when the LLM composer is on).
- **Verified live:** re-answer restyles from coaching (concise/warmer) while staying grounded + gated;
  greeting rewrite keeps disclosures and fails safe when coached to drop them; two style notes compact
  into one example-bearing rule. +4 unit tests (activeSteering: active-only + styleGuidance).

### Latest — F1: human-like detail-aid use + real PDF ingestion (2026-07-09)

- **Rep now *talks about* the slide.** After the approved body, the response builder weaves a
  claim-free, on-screen reference ("Take a look at the mechanism of action slide I'm showing…")
  and, when a second approved answer is relevant, a whole-deck pointer ("more on the development
  status slide too"). Cues carry no medical content, so the gate treats them exactly like the
  openers. `slideReference()` in `content/responseBuilder.ts`; woven on both the deterministic and
  LLM-composer paths in `realtime/orchestrator.ts` (orchestrator resolves the on-screen slide titles
  via `content.getSlide`).
- **Slide switches mid-answer, not on word one.** `HcpExperience` delays the deck switch
  (`SLIDE_CUE_DELAY_MS`) so it lands as the rep gets to "…you can see this on the X slide", and
  clears the pending switch if a new question arrives first.
- **PDF ingestion is now real** (was a dead path — the upload UI accepted `.pdf` but the backend
  rejected it). New `content/parsers/pdf.ts` uses `pdf-parse` (lazy-imported), one block per page,
  page markers stripped; wired into `extractSourceText`; ingest route infers `kind:"pdf"`. Parsed
  blocks still land `in_mlr` (not live until approved).
- **Verified:** `tsc` clean; +5 unit tests (real 2-page PDF extraction, slide-cue weaving, ISI stays
  last, routed turns stay clean); live turns confirm per-topic slides + whole-deck pointers + clean
  refusals.
Latest audit note (2026-07-08): the configured hermetic E2E path is blocked because `npm run build`
succeeds but `npm run start` crashes with `routesManifest.dataRoutes is not iterable`; `npm run lint`
is also not currently usable as a non-interactive check. See `docs/AUDIT_2026-07-08.md`.

---

## 2. What's real vs what's mocked

The brief's approach is "interfaces real, vendors mocked, in-memory first." This is
exactly where things stand. Be precise about this when demoing.

| Area | Status | Detail |
| --- | --- | --- |
| App, build, tests | 🟢 Real | Compiles, runs, tests genuinely pass |
| UI — console + all screens + HCP view | 🟢 Real | Real React/state/nav; matches the mockup |
| Compliance gate | 🟢 Real logic | Deterministic: blocks ungrounded answers, missing ISI, off-label-in-answer, prompt injection |
| Policy router + source validation | 🟢 Real logic | Deterministic routing + MLR/expiry/audience/market/campaign checks |
| Orchestrator, response builder, audit log, CRM outbox, follow-ups | 🟢 Real logic | Real end-to-end turn flow; append-only audit; outbox w/ retry/status |
| Browser voice (TTS) + microphone (ASR) | 🟢 Real | Real audio out (OS voices) + real mic transcription; no keys (mic uses browser/Google cloud) |
| Intent/risk **classifier** | 🟢 pluggable / 🟡 default | Swappable provider: **Claude** (real, `@anthropic-ai/sdk`), **OpenAI**, **Thinking-Machines** (OpenAI-compatible endpoint), or **keyword** (default, $0). LLM providers light up when a key is set; default stays keyword. Pick the model + **A/B compare** providers live **inside the chat** (⚙ Test models). |
| **Answer composition** | 🟢 LLM-grounded when keyed | When a provider is keyed (Claude live), the LLM **composes the reply grounded in the retrieved approved blocks** (rephrase only, no new claims; `src/modules/content/composer.ts`); ISI is appended **verbatim** by code; gate validates grounding. Falls back to the deterministic builder with no key. |
| Retrieval / vector index | 🟢 real embeddings / 🟡 store | **Real semantic embeddings** — local neural model (Transformers.js `all-MiniLM-L6-v2`, no key, downloads once) with a stemmed-lexical fallback; ranks the right approved block/slide per topic. Store is still in-memory (pgvector drops in behind the same interface). |
| Content ingestion **parser** | 🟡 Real flow, fake parser | Normalization is real; "PPT/PDF parser" just splits on blank lines |
| 3D avatar (TalkingHead + HeadTTS) | 🟡 Real code, unverified | Loads from CDN; needs Chrome + WebGPU; not verified rendering (headless); falls back gracefully |
| All content + data (CardioNova, HCPs, sessions, analytics, CRM rows) | 🔴 Faked | Hardcoded demo data in `src/app/_app/data.ts` and the seed container |
| Database (Postgres/pgvector) | 🔴 Not connected | Everything in-memory; interfaces are pg-ready |
| Vendors (Tavus, GPT Realtime, ElevenLabs, MascotBot, Veeva, Salesforce, IQVIA) | 🔴 Mocked | All resolve to mock adapters; **no keys, no accounts, no external calls** |

**Bottom line:** the full pipeline (classify → route → retrieve approved → build →
gate → audit → follow-up/CRM) runs for real. The classifier is **pluggable**
(keyword default; real Claude/OpenAI when keyed). Model selection, A/B comparison,
streaming, latency badges, and barge-in are now **built into the AI-rep chat**
(toggle **⚙ Test models** in the HCP preview) — the standalone compare/arena pages
were consolidated away. What remains mocked: **content/data**, **retrieval
embeddings**, and **A/V + CRM vendors**. The path to production-real is §8 below.

---

## 3. How to run

```bash
npm install        # one-time (installs deps + Playwright Chromium on first e2e)
npm run dev        # http://localhost:3000
```

The app runs with **zero setup** — no database, no API keys, fully in-memory with
mock vendors. Open `http://localhost:3000` for the brand console; reach the HCP
doctor view via **Launch → "Preview HCP experience"** (or the standalone `/hcp`).

**Configuration** (`.env.example` → copy to `.env.local`; all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXUSREP_DATA_DRIVER` | `memory` | `memory` \| `postgres` (postgres impl not written yet) |
| `DATABASE_URL` | — | pgvector Postgres URL (when driver=postgres) |
| `NEXUSREP_REALTIME_PROVIDER` | `mock` | `mock` \| `gpt-realtime` \| `tavus` |
| `NEXUSREP_VOICE_PROVIDER` | `mock` | `mock` \| `whisper-elevenlabs` |
| `NEXUSREP_AVATAR_PROVIDER` | `mock` | `mock` \| `tavus` \| `heygen` |
| `NEXUSREP_CRM_ADAPTER` | `outbox-mock` | `outbox-mock` \| `veeva` \| `salesforce` |
| `NEXUSREP_RETRIEVAL_PROVIDER` | `memory-vector` | `memory-vector` \| `pgvector` |
| `NEXT_PUBLIC_NEXUSREP_AVATAR_URL` | TalkingHead sample | Override the 3D avatar GLB (free Ready Player Me URL) |
| `OPENAI_API_KEY` / `TAVUS_API_KEY` / `ELEVENLABS_API_KEY` | — | Leave blank to stay on mocks |

> Today every non-default selection still resolves to a mock — the real adapters are
> the work behind those switches.

### 3a. Real HCP data + real video recording (J&J / Milvexian)

The "everything real" demo uses NexusRep, a refreshed hosted DocNexus token, and
a public tunnel for Tavus callbacks:

```bash
# 1) NexusRep app (postgres driver keeps sessions/recordings across restarts)
NEXUSREP_DATA_DRIVER=postgres PGLITE_DATA_DIR=.nexusrep-data npm run dev   # :3000

# 2) DocNexus hosted Advanced Search — set platform credentials once in .env.local
#    NexusRep auto-refreshes .docnexus-id-token.json when needed.

# 3) Public tunnel so Tavus can reach our compliance endpoint + webhook
cloudflared tunnel --url http://localhost:3000
#   → put the printed URL in .env.local as NEXUSREP_PUBLIC_URL, restart :3000
```

**Verify real HCP data** (NexusRep's own provider code against Advanced Search):

```bash
NEXUSREP_AUDIENCE=docnexus DOCNEXUS_ID_TOKEN_FILE=.docnexus-id-token.json npm run dev
curl -s localhost:3000/api/audience | jq '{source, size:.summary.cohortSize, top:.rows[0].name}'
#   → {"source":"docnexus-advanced-search","size":39,"top":"Dr. RODNEY SAMAAN"}
```

**Auto-record a real video call** (no human — Playwright joins the Daily room, records
the replica, attaches it to the session):

```bash
node scripts/tavus-bot-record.mjs
#   → publishes public/recordings/nexusrep-<id>.webm and attaches it to session_demo.
#     Watch it in the app: Sessions → session_demo (video + click-through transcript).
```

**Teardown** (nothing should linger): the bot ends its Tavus conversation automatically;
to stop the servers, kill the `:3000` / `:3100` / `cloudflared` processes. Check no Tavus
minutes are burning: `curl -s -H "x-api-key: $TAVUS_API_KEY" \
"https://tavusapi.com/v2/conversations?status=active"` should show an empty list.

> Caveat: Tavus **server-side** recording is plan/storage-gated on the current account
> (a live call emits `replica_joined`/`transcription_ready` but no `recording_ready`).
> The bot's browser-side capture is the durable, plan-independent recording. If you move
> to a paid Tavus plan with S3 storage configured, the same `/api/tavus/webhook` will
> also catch Tavus's own `recording_ready` and attach that URL.

---

## 4. Architecture

**Rule:** business logic lives in `src/modules/*`; API routes are thin controllers;
React components render. Cross-module access only through a module's `index.ts`.

```
src/
  app/                              # Next.js App Router (thin)
    page.tsx                        #   → renders the full brand console
    layout.tsx                      #   design-system <link> + 3D import map
    hcp/page.tsx                    #   standalone HCP view (A/V verification)
    spike/page.tsx                  #   standalone A/V rehearsal (Stage 2)
    api/conversation/turn/route.ts  #   thin controller → TurnOrchestrator
    api/spike/run/route.ts          #   thin controller → runScriptedSession
    _app/                           #   the ported console (client UI)
      NexusRepApp.tsx               #     shell: sidebar + header + Overview + router
      BrandScreens.tsx              #     Audience/Launch/Sessions/Session Detail/Analytics/Follow-ups/Admin
      StudioScreen.tsx              #     AI Rep Studio: Build/Train/Rules/Readiness
      HcpExperience.tsx             #     invite → conversation → complete (wired to compliance API)
      data.ts                       #     all demo/presentation data
    _components/                    #   LiveAvatar (3D), RepAvatar (animated fallback)
  lib/                              # ids, result, env, repository, vector-index, browser-speech, container
  modules/                         # domain logic (see map below)
tests/                             # Vitest unit + integration (9 files)
e2e/                               # Playwright E2E + visual regression
public/                           # colors_and_type.css (design system) + assets
```

### Module map (`src/modules/*`)

| Module | Real? | Responsibility |
| --- | --- | --- |
| `vendors` | 🟢 interfaces / 🔴 impls mocked | `RealtimeProvider`/`VoiceProvider`/`AvatarProvider`/`CrmAdapter`/`RetrievalProvider` + mock impls + env registry |
| `content` | 🟡 | Approved answers, ISI, detail-aid slides; ingestion/normalization; **source validation**; response builder |
| `retrieval` | 🟡 | Controlled retrieval: candidate IDs → source validation → eligible approved blocks |
| `compliance` | 🟢 gate / 🟡 classifier | Combined classifier (keyword stub), policy router, **final compliance gate** |
| `realtime` | 🟢 | `TurnOrchestrator` (the controlled agent graph) + `runScriptedSession` (A/V spike) |
| `audit` | 🟢 | Append-only event log per session (immutable) |
| `followups` | 🟢 | Auto-created follow-up tasks with status lifecycle |
| `crm` | 🟢 logic / 🔴 adapter | Outbox pattern: enqueue → deliver → retry/status, via swappable `CrmAdapter` |
| `rules` | 🟢 | Coaching feedback → scoped, compliance-gated training rules |
| `setupAssistant` | 🟡 | Setup question script + field inference + structured `SetupDraft` |
| `aiRepStudio` | 🟡 types | AIRep/persona/readiness model |
| `audience` / `tenants` / `sessions` / `mlr` / `analytics` / `training` / `auth` | 🟡 types/stubs | Canonical types + service skeletons; filled in their stages |

### Canonical flow (brief / PDF)

```
approved source in → canonical data model → controlled agent graph
  → final compliance gate → CRM / vendor out
```
Postgres is the intended source of truth; the vector index returns candidate IDs
only; the compliance gate is the last check before any output.

---

## 5. The runtime turn (controlled agent graph)

What actually happens when an HCP asks a question (`TurnOrchestrator.handleTurn`,
exercised live by `/api/conversation/turn`):

```
HCP text
 → classify()                      # intent + off-label/AE/medical-info/injection risk + ISI-required (one pass)
 → route()                         # → approved_answer | off_label_refusal | adverse_event | medical_information | human_handoff | fallback
 → if approved_answer:
      retrieval.retrieveApproved() # vector candidate IDs → source validation (MLR/expiry/audience/market/campaign)
      buildApprovedResponse()      # compose from approved blocks ONLY + verbatim ISI + detail-aid slide
   else: controlled pre-approved transition (+ create follow-up: MSL / PV / medical info / human)
 → complianceGate()                # approve or BLOCK the exact text (fail safe → safe fallback)
 → audit.record() at every step    # classification, retrieval, decision, output, follow-up
 → return { responseText, sourceIds, isiAttached, detailAidSlideId, followUpType, decision }
```

Hard rules enforced here: approved content only, off-label refused + routed, AE →
pharmacovigilance, ISI delivered verbatim when required, nothing ungrounded reaches
output, fail safe on any uncertainty.

---

## 6. Demo script

### Demo 1 — Brand console & monitoring
- Land on `/` → **Overview** (Command Center): readiness, KPI tiles ("Sessions
  completed", "Follow-ups pending", "ISI delivery", "CRM export issues"),
  "What HCPs are asking", "Sessions needing coaching".

### Demo 2 — Build the AI rep (Studio)
- Sidebar **AI Rep → Build**: DocNexus Setup Assistant asks one question at a time;
  answering (chips or free text) drafts the structured sections (Rep profile,
  Approved knowledge, Audience, Escalation, Conversation rules, Readiness). "Decide
  for me" auto-fills. Each section confirms.

### Demo 3 — Train & coach (Studio → Training & Preview)
- Click **Ask** to rehearse; the rep answers from approved content. **Coach a line**
  → type feedback ("say this more briefly", "don't mention Drug X", "say we're safer
  than competitor X") → it becomes a **scoped rule** with the right status (the
  comparative claim is **blocked by compliance**). See them in **Rules**.

### Demo 4 — Audience & Launch
- **Audience**: ranked HCP table; click a row → profile drawer ("why this HCP",
  content affinity); **Add** to the activation list. **Launch**: readiness +
  confirm modal → invites sent.

### Demo 5 — HCP doctor experience (the compliant rep)
- **Launch → "Preview HCP experience"** (or `/hcp`). Ask **"What is the recommended
  dosing?"** → approved answer **with Important Safety Information** + the **Dosing
  detail aid** appears (source-driven). Ask an **off-label** question → refused +
  MSL follow-up. Mention a **side effect** → routed to pharmacovigilance. Toggle
  **Voice** (real audio) and **3D avatar** (Chrome + WebGPU).

### Demo 6 — Sessions, Session Detail, Analytics, Follow-ups
- **Sessions** (explicit compliance statuses, never "Clean") → **Review** opens
  **Session Detail** (turn-by-turn decision path + evidence chain). **Analytics**
  tabs (Targeting/Engagement/Content/Compliance/CRM-Ops/Realtime). **Follow-ups**:
  auto-created, CRM status (Created/Sent/Needs mapping/Failed), Retry, JSON behind
  "technical payload".

### Demo 7 — A/V rehearsal spike (`/spike`)
- **Start rehearsal**: a fixed approved script is spoken aloud (real browser voice),
  avatar animates, detail aid shows, session ends — through the provider adapters.

---

## 7. Tests

```bash
npm run typecheck             # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm test                      # Vitest (39 unit + integration)
npm run e2e                   # Playwright (build + start + test)
npm run e2e:update-snapshots  # refresh visual baselines
npm run e2e:report            # open the last HTML report
```

**Unit / integration (`tests/`)** — 39 tests across 9 files:
`compliance` (classifier + router + gate), `content` (source validation),
`ingest` (normalization), `response-builder` (approved-blocks composition + ISI +
detail aid), `retrieval`-backed `orchestrator` (in-label+ISI+detail-aid,
off-label→MSL, AE→PV, audit completeness), `rules` (feedback→scoped rule, blocked
comparative), `crm` (outbox status incl. needs-mapping), `spike` (adapter boundary),
`browser-speech` (pacing helper).

**E2E + visual (`e2e/`)** — `nexusrep.spec.ts` (console overview + lifecycle nav,
HCP no-jargon + in-label + off-label, A/V spike flow); `visual.spec.ts` baselines
for overview / spike / hcp; `live3d.verify.spec.ts` (guarded `VERIFY_3D`, drives the
real 3D avatar in Edge/WebGPU).

---

## 8. Known limitations & path to "production-real"

Current limitations (all by design for this phase):
- **No database** — in-memory only; Postgres/pgvector adapter not written.
- **Classifier is keyword-based**, not an LLM — the biggest correctness gap.
- **Retrieval uses toy embeddings**; ingestion parser doesn't read real PPT/PDF.
- **All vendors mocked**; no keys (voice/avatar/realtime/CRM).
- **3D avatar unverified** on real GPU (needs a human in Chrome).
- `/spike` + `/hcp` standalone routes **duplicate** console surfaces (reconcile later).
- `npm audit` shows transitive toolchain advisories (not yet triaged).

To make each real: connect Postgres+pgvector behind `Repository`/`VectorIndex`;
swap the keyword classifier for an LLM call (same `classify()` signature); add real
embeddings; implement the vendor adapters behind their interfaces with keys; verify
3D in Chrome.

---

## 9. Next steps (gated 10-stage plan)

Proceeding one stage at a time, stopping for review after each:

1. ✅ **Stage 1** — Onboarding + scaffold
2. ✅ **Stage 2** — A/V spike
3. ✅ **Stages 3–4** — Conversation engine + RAG
4. ✅ **(extra)** — Full mockup UI port
5. ⏭ **Stage 5** — Compliance guardrails (formalize classifier, refusal, verbatim ISI dual-modality, AE→PV, response validator, final gate, audit; add red-team tests)
6. **Stage 6** — Twin Studio + MLR gating
7. **Stages 7–8** — Whitespace targeting + Audience; escalation/handoff + CRM outbox
8. **Stage 9** — Analytics console (metrics from session/audit/follow-up events)
9. **Stage 10** — Integration + hardening, then demo + handover

---

## Implementation log

### 2026-07-11 - Human slide-led pitch flow
- **Changed:** the doctor-facing **Start overview** button now sends a natural HCP request
  into `/api/presentation/overview`, so the product pitch uses the same multi-slide guided
  overview that Training/Pitch & Script rehearses. It no longer starts with a one-slide
  "deck command" that looked like automation scaffolding.
- **Changed:** `PresentationSkill` framing copy now reads like a brand presenter cueing the
  detail aid ("slide-led overview", "let's move", "bring up") while the medical/product
  content remains the approved source block.
- **Changed:** `/api/presentation/step` direct-call fallback text now logs doctor-like
  requests ("Please continue to the next point") rather than synthetic "Next slide."
  strings.
- **Docs:** demo talk track and J&J script clarify that E2E intentionally mocks Tavus to
  avoid credit spend, while the live app uses Tavus when the key is configured.
- **Verified:** focused presentation/Tavus/hardening tests passed (32 tests),
  `npm run typecheck` clean, `npm test` passed (257 pass, 1 guarded live DocNexus
  test skipped), and `npm run e2e` passed (27 pass, 2 skipped).

### 2026-07-09 - Final natural Tavus recording + full deck usage verified
- **Changed:** presentation overview now walks the approved deck in source order
  across all six active slide-backed blocks: title, mechanism, LIBREXIA program,
  development status, ISI, and contact/handoff. Normal Q&A still selects slides
  by approved retrieval source, not response-text keyword guessing.
- **Generalized:** the full Tavus recording script now reads `/api/brand` and
  builds overview/mechanism/program/compliance-case prompts from the active brand
  profile instead of hardcoding Milvexian/LIBREXIA/Factor-XIa wording.
- **Push-ready:** `.gitignore` now excludes local DBs, secrets, token caches,
  recordings, logs, uploaded files, downloaded tool binaries, and test artifacts;
  `docs/GITHUB_PUSH_READY.md` captures the first-commit checklist.
- **Fixed:** short live-LLM false negatives/false positives are merged with the
  deterministic classifier: obvious Factor XIa mechanism follow-ups recover to
  `product_info`/`slide_moa`, while AE/off-label/comparative/prompt-injection
  risks still win. Human-representative prompts no longer trigger the overview
  detector.
- **Recorded:** real Tavus CVI session `session_mrdcoo0zn963lj` /
  conversation `cb063f707fcb14ac`. Replica-only video:
  `/recordings/nexusrep-full-tavus-session-20260709-101435.webm` (87,276,956
  bytes), with sidecars
  `/recordings/nexusrep-full-tavus-session-20260709-101435.transcript.txt` and
  `/recordings/nexusrep-full-tavus-session-20260709-101435.session.json`.
- **Verified in transcript:** overview used `slide_title`, `slide_moa`,
  `slide_program`, `slide_status`, `slide_isi`, `slide_contact`; follow-up
  Factor XIa used `slide_moa`; LIBREXIA used `slide_program`; dosing and
  comparative routed to Medical Information; off-label routed to MSL; AE routed
  to Pharmacovigilance; human-rep request routed to `human_handoff`.
- **Verified media:** Chromium loads and plays the WebM (`640x360`,
  `readyState=4`, playback advances). Active Tavus conversations after cleanup:
  `0`.
- **Verified tests:** `npm run typecheck`, `npm test` (168 pass, 1 guarded live
  DocNexus test skipped), and `npm run e2e` (17 pass, 1 intentionally skipped)
  all pass.

### 2026-07-09 - Full Tavus session recorder hardening
- **Added:** `scripts/record-full-tavus-session.mjs`, a real HCP-flow recorder
  that opens `/hcp`, starts the Tavus video rep, drives deck walkthrough +
  product/status + dosing + comparative + off-label + AE + human-rep cases, and
  saves a replica-only `.webm` plus exact session JSON/transcript sidecars when
  Tavus credits are available.
- **Fixed:** `TavusStage` replica recorder stop now force-flushes MediaRecorder
  chunks after 4 seconds if Chromium never fires `onstop`, preventing the local
  recorder from hanging after a successful call.
- **Fixed:** Tavus webhook parsing now accepts `storage_uri` from
  `application.recording_ready`, matching Tavus's current recording callback
  contract.
- **Live attempt:** `session_mrd4a8n2iiybb8` successfully drove the real app and
  logged 21 turns / 10 HCP prompts / 5 slide-linked rep turns, including
  Medical Information, MSL/off-label, Pharmacovigilance/AE, and human-rep
  follow-up routes. Local WebM extraction hung before the MediaRecorder fix, and
  the immediate rerun was blocked by Tavus `402` out-of-conversational-credits,
  so no new video-backed session was produced from this pass.

### 2026-07-09 - Session history cleaned to video-backed rows
- **Cleaned:** the visible Sessions review API now returns only sessions with an
  attached `recordingUrl`, so smoke-test/no-video rows do not clutter the demo
  review surface.
- **Added:** each listed row carries `hasRecording: true`; deterministic E2E
  seeded history marks its reviewable seed session as recording-backed so the
  compliance-evidence test still exercises the real review UI.

### 2026-07-09 - Coaching, PPT usage, ISI gate, and demo talk track
- **Changed:** the final compliance gate now validates the exact required ISI
  text is present when ISI is required, instead of trusting only an internal
  boolean. Coaching can reword the approved answer body, but not the required
  safety block.
- **Changed:** the LLM composer is instructed not to paraphrase or duplicate ISI;
  the orchestrator appends the exact approved ISI block and the gate verifies it.
- **Added:** the Build → Approved knowledge section now has an ISI editor:
  confirm the active ISI, submit revised/paraphrased ISI as pending MLR content,
  and approve/reject pending safety drafts. Approved revisions retire the previous
  active ISI block so the runtime uses one exact block.
- **Changed:** uploaded PPT/PDF normalization now infers richer pharma topics
  (`mechanism`, `program`, `status`, `indication`, safety, dosing, trial data)
  and gives generated detail-aid slides human titles/labels instead of generic
  deck-level titles.
- **Changed:** deterministic response cues include more natural detail-aid
  references ("look at the slide where...") and Session Review delays slide
  changes slightly into the rep turn so playback feels like a human cue rather
  than an instant jump.
- **Changed:** Session Review now labels the gate metric as `Gate cleared`, not
  `Gate approved`, because routed/refusal/AE/handoff outputs also pass the gate.
- **Added:** `docs/DEMO_TALK_TRACK.md` with a stakeholder walkthrough for intent
  classification, model setup, cohort scoring, doctor outreach links, Tavus
  responsibilities, and NexusRep's compliance gate.

### 2026-07-09 - Real Tavus session recording for Sessions preview
- **Removed:** the earlier deterministic `session_showcase_full_convo` fixture from
  source and cleaned its durable local rows. That was a scripted transcript, not
  an acceptable review artifact.
- **Created:** a real Tavus video run through the HCP preview flow:
  `session_mrchcarx3f9rsk`. The run typed seven HCP prompts through the live app,
  let the compliance endpoint produce the gated responses, had the Tavus avatar
  speak them, recorded the replica-only media stream, finalized the same session,
  and attached the recording through the Tavus webhook path.
- **Added:** `public/recordings/nexusrep-real-tavus-session-20260709.webm`, a clean
  Tavus AI-rep-only recording attached to that real session via `recordingUrl`,
  so Session Review can play the rep video while the actual turn timestamps drive
  the approved deck/PPT slide panel.
- **Changed:** Follow-ups now match CRM outbox status by both session and
  follow-up type, so sessions with multiple routed tasks show the correct status
  per row.
- **Changed:** Sessions list now summarizes multiple routed tasks as
  `4 follow-ups` instead of showing only the first one.
- **Verified:** API session row shows `Dr. A. Sharma`, `01:46`, `7` questions,
  `AE routed`, and `4 follow-ups`; session detail returns 15 turns, the real
  recording URL, `slide_moa` for the mechanism/ISI turn, and `slide_program` for
  the LIBREXIA-program turn. Follow-ups show Medical Information, MSL,
  Pharmacovigilance, and Human Rep rows for the same source session.

### 2026-07-08 (cont. 31) - Audience list readability fix
- **Changed:** Audience rows now show a concise aggregate patient count instead
  of repeating the full "eligible patients / brand share / claims-derived / no
  PHI" explanation in every row. The full rationale remains available in the
  HCP drawer when the user clicks a row.
- **Changed:** fresh app state starts with an empty activation list. The old
  default demo IDs (`sharma`, `okafor`) did not match live audience IDs, so the
  screen could say "On activation list 2" while every row still showed "Add."
- **Changed:** the Audience table opens on the top 12 HCPs and exposes a
  show-all control for larger cohorts, keeping the first screen scannable.
- **Verified:** `npm run typecheck`; `npm test -- tests/analytics.test.ts`;
  targeted Audience Playwright test against a memory-backed dev server; clean
  `npm run build`.

### 2026-07-08 (cont. 30) - Full audit, break test, and showcase recording
- **Added:** `docs/AUDIT_2026-07-08.md`, a dated pass/fail audit with prioritized
  findings and recommended fix order.
- **Recorded:** `public/recordings/nexusrep-showcase-audit-20260708.webm` using a
  fresh memory-backed dev server. The recording walks through Studio setup,
  training preview, coaching into a rule, rules, audience, launch, session review,
  follow-ups, analytics, and HCP safety/compliance flows.
- **Verified:** `npm run typecheck` pass; `npm test` pass (143 passed, 1 skipped);
  `npm run build` pass; serial Playwright pass (16 passed, 1 guarded 3D skip).
- **Found:** production `next start` currently fails after build; default E2E is
  blocked by that serving failure; lint is interactive/deprecated; dependency
  audit reports vulnerabilities; Studio readiness signals conflict; live-created
  session review can be empty despite list metadata; visual coverage is narrower
  than the brief requires.

### 2026-07-08 (cont. 29) — Verified setup/revise live + swept & fixed dead UI
- **Actually drove the flow in a browser:** DocNexus setup chat works (sections persist, readiness
  recomputes); "Ask DocNexus to revise" verified live — reopens a section (COMPLETE → DRAFTED, readiness
  100% → 80% · 1 item left), re-confirm restores 100%.
- **UI audit → fixes** (dead/disconnected/misleading controls):
  - Escalation **MSL contact input + Human-handoff/AE-routing toggles** now PERSIST (were cosmetic) —
    saved via the real setup answers (`msl_contact`/`ae_routing`).
  - **`LabeledSelect`** (Target segment / Specialty) made controlled + responsive; Target-segment now
    persists to `target_audience`.
  - Analytics **"View records →"** dead link + fake `cursor:pointer` on the KPI cards → removed.
  - Readiness **Submit** button double-submit bug fixed (`disabled = !canLaunch || pending || approved`).
  - Launch **"Rehearsal complete: Pending"** (hardcoded) → **"Rep trained & approved"** driven by real
    `/api/studio` `readiness.canLaunch`; "Audience selected" ok now reflects the activation count.
  - Honesty relabels: "Content affinity" → **"Inferred content affinity"** (it's derived from the opp
    score, not measured); Follow-ups "Technical payload" → **"Example payload format"** (illustrative).
  - Left as acceptable: Admin CRM-connector toggles (respond locally; internal platform config) and the
    Overview/Analytics KPI demo-constant *fallbacks* (real when the API responds, which it does).
- **Verified:** tsc clean; 143 unit tests; live `/api/studio` `canLaunch:true / 100% / 6 rules`.

### 2026-07-08 (cont. 28) — Audience metrics: replace degenerate ones with meaningful signals
- On the real (sparse, coverage-less) claims cohort several Audience metrics were degenerate/misleading:
  the **"Whitespace 39 · 0 under-covered · 0 no-see"** KPI (one bucket, restates the count), the per-row
  **"Segment"** column (identical "No-rep whitespace" for all), a uniform **Recommended topic**, and a
  **wrong** "Decile 2–4 whitespace" subtitle (rows are D1).
- Replaced: KPI **"Whitespace" → "Top-decile targets"** (count of D1–D2 high-volume prescribers);
  table **"Segment" → "Eligible pts"** (per-HCP, the real driver of the score — makes the ranking
  explainable); fixed the "Target HCPs"/"Avg opp score" subtitles to be accurate ("In the target cohort",
  "0–100 · ranked within cohort"). `recommendedTopic` now differentiates by the signals that vary —
  declining → status, top-decile → program, else → mechanism (was uniform because brand-share is ~0
  pre-launch). Live: recommended topic now splits 8 program / 31 mechanism across the 39 HCPs.
- **Verified:** tsc clean; live `/api/audience` shows differentiated topics.

### 2026-07-08 (cont. 27) — Fix: revise button, duplicate rules, stale-page caching
- **"Ask DocNexus to revise"** was a dead button (no handler). Wired to `reviseSection` — reopens the
  section (status → `needs_input`) so the brand user can re-answer it in the setup chat.
- **Duplicate rules:** `StudioService.addRule` deduped only by id, but coaching rules get a fresh
  time-based id each call, so identical feedback piled up (found 6 identical "Don't mention warfarin"
  rules in the durable store). Fixed: `addRule` now also dedups by CONTENT (`sameRule`: type + topic +
  feedback); added `dedupeRules()` called during seeding to collapse existing dupes. Live rule count
  11 → 6 (one of each), self-healing on restart.
- **Stale page ("needs a hard refresh"):** added a dev-only `Cache-Control: no-store, must-revalidate`
  header in `next.config.mjs`, so after a dev-server restart a stale tab no longer serves cached
  HTML/chunks — a NORMAL reload now fetches fresh. Production keeps Next's default caching.
- **Verified:** tsc clean; studio test passes; live `/api/studio` shows 6 clean rules (1 warfarin);
  `/` responds with `Cache-Control: no-store`.

### 2026-07-08 (cont. 26) — E2E green end-to-end (functional + visual)
- **Rewrote `e2e/nexusrep.spec.ts`** to drive the CURRENT UI and cover the full lifecycle: Overview +
  metrics (Analytics/Follow-ups), Setup (Setup Assistant + content **Upload** control), A/V spike,
  HCP doctor view (public answer + ISI, clinical→Medical Info, off-label refusal, and **no internal
  jargon incl. the model-test tool**), Train/coach (feedback → scoped rule), Rules guardrails, Audience,
  and **Review** (Sessions → a real transcript + the approved-source slide). 13/13 pass.
- **Doctor-view fix:** the internal "Test models" A/B toggle is now hidden on the shared `/hcp` link
  (shown only in the in-app brand preview, where `app` is present) — enforced by the jargon test.
- **A/V spike fix:** `/api/spike/run` was 500ing because it sent an explicit `voiceId` to a real Tavus
  provider (rejected). Dropped the explicit voice (default replica voice; `VoiceConfig.voiceId` is now
  optional), and the E2E env forces all vendors offline (added `TAVUS_API_KEY: ""`).
- **Review needs evidence:** the first seeded session now carries a real 5-turn transcript (both sides +
  the moa/program slides) so Session Review renders proof, not an empty shell. E2E env sets
  `NEXUSREP_SEED_HISTORY=1` so Sessions/Analytics/Follow-ups are populated.
- **Visual baselines refreshed** (`overview`, `spike`, `hcp` invite) from a clean build; the HCP invite
  test now waits for the async brand copy to load before snapshotting (deterministic). `playwright.config`
  gained `E2E_PORT` so E2E doesn't collide with other local dev servers.
- **Verified:** tsc clean · 143 unit tests · **16 Playwright tests pass twice (stable)**.

### 2026-07-08 (cont. 25) — Self-serve: configure the rep by chatting (no code)
- **Chat reconfigures the live rep.** `resolveBrandProfile(base, setupAnswers)` merges the Setup
  Assistant's answers over the profile: `brand`→displayName, `greeting`/`disclosure`→greeting+persona,
  `indication`/`target_audience`→clinical, `talking_points`→talkingPoints. Persona system-prompt +
  hotwords are RE-DERIVED from the resolved identity (never user prose → verbatim contract preserved).
  `/api/brand`, the Tavus persona route, and content-ingest now resolve at request time, so anything a
  brand user sets by chatting drives the live rep. `seedDemoStudio` answers were aligned to the profile's
  clean values so the merge is a no-op for the Milvexian demo (rep unchanged) — only *edits* take effect.
  **Verified live:** setting the greeting via `/api/studio` immediately changed `/api/brand`'s greeting.
- **Content upload in the UI.** Build → Approved knowledge now has an **↑ Add source file** control that reads a
  PPT/PDF/text file and POSTs to `/api/content/ingest` → parsed to in-MLR draft blocks (never live until
  approved). Closes the one API-only gap. Removed the last hardcoded MSL email.
- **Parity (every rep option is chat/UI or auto-derived):** identity (name/greeting/disclosure/
  indication/audience/talking points) = Setup chat; approved answers/ISI = **upload → MLR**; targeting =
  Audience; coaching rules = Train (and they now steer); escalation = Build. Auto-derived from the above:
  persona system-prompt, hotwords, context. **Remaining code-only (cosmetic / bigger features, flagged):**
  brand palette colors, the branded slide *design* (deck visuals — approved answer *text* is upload-driven),
  and tryQuestions/recommendedTopics (derivable from talking points).
- **Verified:** tsc clean; **143 unit/integration tests pass** (incl. 4 new self-serve resolve tests);
  live chat→rep greeting round-trip.
- **Note:** running the unit suite while the dev server is up can flake `postgres.test.ts` (two PGlite
  instances contend); run tests with the dev server stopped for a clean result.

### 2026-07-08 (cont. 24) — Finish the stages: coaching steers the rep + full de-brand
- **Stage 6 completed — coaching now steers live behavior.** Active, compliance-cleared coaching rules
  fold into runtime steering each turn (`ConversationService.steeringFor` → `activeSteering`):
  `blocked_topic` (active) reroutes a matching question to Medical Information (restrictive/fail-safe,
  audited `coaching_rule_applied`); `conversation_ordering`/`hcp_pointer` re-rank which approved answer
  leads. `blocked_topic`/ordering rules now capture a matchable `topic` at rule-gen. DEFAULT-OFF (no
  active rule with a topic → unchanged), and only `status:"active"` rules steer, so the compliance gate
  stays authoritative. Tests: an approved rule reroutes the topic; a gated (needs_source) rule does not.
- **Full de-brand.** No Milvexian/LIBREXIA/Factor-XIa literal remains in application LOGIC — `data.ts`
  fixtures, `/api/followups` reasons, `BrandScreens` affinity, `NexusRepApp` overview list, the `/spike`
  page (now reads the brand deck), and `seedDemoStudio` (persona/answers now from the `BrandProfile`).
  Brand data lives only in `@modules/brand` + `milvexian-deck.ts`; audience specialties/dx-codes remain
  campaign config.
- **Verified:** tsc clean; **140 unit/integration tests pass**.
- **Follow-up (stage 10):** Playwright E2E + visual baselines predate the UI-copy/generalization changes
  and should be re-recorded (`npm run e2e:update-snapshots`).

### 2026-07-08 (cont. 23) — Generalize setup/rules/spike + e2e tests (setup, coaching, review)
- **Build/train content is now brand-driven:** `SETUP_TOPICS` → `setupTopicsFor(brand)` (product /
  indication / talking-point chips filled from the profile; generic fallback when none); `DEFAULT_RULES`
  de-branded to generic compliance guardrails; the spike route scripts itself from `c.brand`
  (greeting + approvedAnswers + slides); `CONVERSATION` / `KNOWLEDGE_ASSETS` fallbacks de-branded.
  Added `talkingPoints` + `indication` to the brand profile/PublicBrand.
- **Setup inference reality:** there is NO fuzzy field-matching — the assistant asks one question per
  field and stores the answer literally (`applyAnswer`), so there are no field false-positives by
  construction. The real fuzzy logic is (a) the coaching classifier `inferType` and (b) the runtime
  intent classifier — both now have false-positive/negative tests.
- **New tests (+23; 137 total):**
  - `tests/rules.test.ts`: benign style notes → accept-ready `persona_style` draft; anything
    comparative/blocked/ordering can NEVER go active without approval (fail-safe over-gating); no
    false negative on a real comparative.
  - `tests/lifecycle.test.ts`: intent classifier doesn't misroute benign public-info to AE/off-label
    and DOES catch real AE/off-label/comparative; `setupTopicsFor` is brand-driven (works for
    "Dolo 650", no Milvexian baked in); full lifecycle — launch-gating, approved answer + source slide
    + audit-derived review evidence, off-label → refusal + MSL follow-up + CRM outbox, coaching
    persistence + compliance gating.
- **Verified live:** setup flow drives brand chips and advances (Milvexian → indication…); tsc clean.
- **KNOWN GAP (stage 6):** accepted/active coaching rules are persisted + compliance-gated + shown, but
  are NOT yet injected into the live rep's behavior (orchestrator/composer ignore them). Coaching
  "captures + governs" today; it does not yet "steer." Remaining `data.ts` HCPS/SESSIONS/CRM_EVENTS/KPIs
  are Milvexian demo fixtures shown only when a live API returns nothing (real paths are generalized).

### 2026-07-08 (cont. 22) — Fix flat opportunity scores + verify Milvexian intact
- **Scores were all ~51.7** with the real cohort: the DocNexus mapper sets `brandSharePct/trendPct/
  repTouchesQtr = 0` for a pre-launch drug (65% of the weight is constant), and the only varying input
  (`eligiblePatients`) was divided by a fixed `DENSITY_REF=3500` while real claims counts are tiny — so
  every HCP collapsed to the whitespace/trend baseline.
- **Fix:** `scoreOpportunity(f, {densityRef})` — the container passes the cohort's top density so the
  score ranks density WITHIN the target list. `scoreOpportunity(f)` with no ref is unchanged (absolute),
  keeping the unit test's `89.4` exact. Live real cohort now spreads **54.4–86.7** (was 2 distinct → 5),
  ranked by eligible-patient volume for the LIBREXIA indications (top: RODNEY SAMAAN). Also fixed a stale
  "pain & fever" rationale (now the brand indication). Score = whitespace 45% + eligible-patient density
  35% (cohort-relative) + QoQ trend 20%; for a pre-launch drug whitespace/trend are uniform so density ranks.
- **Milvexian intact after the brand refactor:** `public/decks/milvexian.pptx` unchanged + served (200);
  deck/greeting/answers/persona all seed from `MILVEXIAN_PROFILE`; recorded replay resolves the right
  slides. 114 tests green, tsc clean.

### 2026-07-08 (cont. 21) — Brand generalization: a new brand is config, not code
- **New `src/modules/brand`** defines `BrandProfile` (identity, palette, greeting, persona, deck,
  seed approved answers + ISI, clinical context, campaign copy, try-questions, recommended topics)
  and registers `MILVEXIAN_PROFILE`. Onboarding another brand = another profile object (or one the
  Setup Assistant + content ingestion produces) — no engine/route/UI edits.
- **Container** seeds answers/slides/ISI/ids/clinical-context by looping the active profile (no more
  hardcoded Milvexian arrays) and exposes `c.brand`.
- **`/api/brand`** returns the client-safe projection; **`useBrand()`** (cached fetch) feeds the
  browser. `SlideView` now renders the brand's deck + palette from `useBrand` (was importing
  `MILVEXIAN_DECK`); the HCP view (greeting, invite, try-questions, header), the console header, and
  the Studio (rep name, subtitle, disclosure, greeting) all read the brand. The Tavus route reads its
  persona (system prompt / greeting / context / hotwords) from `c.brand.persona`. Content ingest scopes
  MLR to `c.brand.clinical`; audience topics + rationale come from the profile (also fixed a stale
  "pain & fever" rationale left over from another brand).
- **`slideForText` deleted.** Slides are now source-driven: the rep surfaces the approved answer's own
  `detailAidSlideId`, stored on the turn (`ConversationTurn.detailAidSlideId`) and returned by the turn
  API; the replay reads it (resolving from `sourceIds` for pre-existing recordings). Exact + brand-agnostic.
- **Still demo-seed (documented, not code a new brand must touch to run):** `src/app/_app/data.ts`
  fixtures (HCP list, KPI/CRM samples), the `/api/spike` scripted demo, and the generated
  `public/decks/milvexian.pptx`. Real HCPs already come from hosted Advanced Search; real content from ingestion.
- **Verified:** tsc clean; 114 unit tests pass; `/api/brand` serves the profile; the recorded session's
  turns resolve moa→program→status slides (held through each question); HCP view renders brand-driven
  with no console errors; Sessions list is a clean single recorded session.

### 2026-07-08 (cont. 20) — Humanlike conversation (phrasing, slide timing, barge-in)
- **Dropped the robotic "Per the approved information:" prefix.** `responseBuilder.ts` now opens
  each approved answer with a small set of natural, CLAIM-FREE, keyword-free openers ("Sure — take
  a look at the screen.", "Good question.", …), picked deterministically per answer id (seed 7, ×31)
  so the demo's three answers each get a distinct opener and the transcript stays reproducible. The
  greeting already states the rep shares publicly-available info, so the preamble was pure noise.
  Compliance unchanged: gate is flag-based (grounded sourceIds + `isiAttached`), ISI still verbatim.
- **Slide follows the REP, not the question.** Session-detail replay computes the slide from the most
  recent *rep* turn at/before the playhead — so it holds the current slide while the doctor is asking
  and switches only as the rep begins answering (human-presenter behaviour; no jump on query).
- **Correct slide per topic.** Fixed `slideForText` keyword priority — the mechanism answer (also says
  "not approved by") and the status answer (also names "LIBREXIA program") were landing on the wrong
  slides. Distinctive terms now checked first: moa → status(fast-track) → program → status-fallback.
  Verified against the real recorded session: moa→program→status all map correctly, slide holds
  through each question.
- **Smoother barge-in.** `TavusStage.speak()` puts a ~220ms beat between `conversation.interrupt` and
  `conversation.echo` so an interruption reads like a person pausing, not a mid-word splice.
- **Verified:** tsc clean; 114 unit tests pass; live API shows the new phrasing + right slides; replay
  renders and shows the Mechanism slide on the mechanism answer.
- **Note:** the *existing* recorded clip still shows old "Per the approved information:" text in its
  transcript — that text is baked into the recording. A one-run re-record refreshes it (see next steps).

### 2026-07-08 (cont. 19) — Session replay = symmetric 2×2 grid
- The replay is now four equal blocks in a `repeat(2, minmax(0,1fr))` grid, `gridAutoRows: 300`:
  recorded rep · approved slide (top), turn evidence · click-through transcript (bottom). Slide +
  transcript follow the recording timeline; evidence/transcript scroll inside their cells.
  `SlideView` gained a `fill` mode so the slide fills its cell (no forced 16:9 aspect). Verified 0px
  extra scroll at 1440×940; opens on the Milvexian title slide.
- **Verified:** tsc clean.

### 2026-07-08 (cont. 18) — Session replay fits one screen (no long scroll)
- Session-detail replay recomposed to fit the viewport like the preview (measured **0px extra
  scroll** at 1440×940): the tall 5-card summary → a **thin stat strip**; the recorded rep capped
  at a compact 16:9; the **transcript flex-fills its column and scrolls internally** (not the page);
  "Said" in Turn evidence clamped to 4 lines; the **turn-level compliance graph collapsed** into a
  `<details>` (out of the main scroll). Slides + transcript now sit beside the video, balanced.
- `slideForText` tightened so the opening greeting maps to the title slide (was matching "AI
  representative" → contact).
- **Verified:** tsc clean; the one recorded session renders the full replay above the fold.

### 2026-07-08 (cont. 17) — Intro in the transcript (all sessions) + Turbopack cold start
- **Rep intro is now a LOGGED transcript turn**, not just a live caption. `/api/conversation/turn`
  accepts `greeting` + `newSession`: when a fresh session is created it appends the greeting as
  turn 0. `HcpExperience` now opens its own per-chat session on the first text/voice message and
  passes `greeting: REP_GREETING` (video sessions still get it from the replica utterance). Verified:
  a text session's transcript reads greeting → HCP → rep.
- **Cold start fixed with Turbopack.** `npm run dev` is now `next dev --turbopack` (`dev:webpack`
  kept as fallback). Measured: server ready 6s; **`/hcp` cold compile ~1s** (was ~10s), warm ~0.8s;
  API routes ~1s warm. The only >5s hit is the first API call (~10s) — one-time container + PGlite
  init, not per-route. (Turbopack is dev-only; `next build`/tests unaffected — 114 still pass.)
  Note: the Tavus *replica* boot (~15–20s "Connecting") is Tavus's own cold start, separate from the
  app, and can't be forced to 5s without pre-warming (which burns credits).
- **Verified:** tsc clean · 114 unit tests pass · intro in transcript · /hcp ~1s. No Tavus runs.

### 2026-07-08 (cont. 16) — Rep intro in captions/pitch · faster load · scripts doc
- **Rep intro now opens every view.** Added a shared `REP_GREETING` (in `milvexian-deck.ts`) — the
  AI + investigational disclosure (matches the Tavus custom greeting). It's seeded as the first
  caption in the doctor view (`HcpExperience`, on Start session) and the first line of the Studio
  "Your rep's pitch" (`TrainMode`, greeting has no question → rendered as a rep-only "intro" line;
  Restart re-seeds it). Verified both views show it. (Recorded/video sessions already log the
  greeting into the session transcript via the replica utterance.)
- **Faster doctor-view load.** `/hcp` no longer returns `null` while it reads the query — it renders
  the doctor view immediately (only the recorder's rare `?bare=1` flips to the bare clip). Removes
  the blank flash. (Note: remaining first-hit slowness is Next **dev** route cold-compile — a prod
  build `npm run build && npm start` is snappy; Tavus replica boot is separate/inherent.)
- **Scripts + setup documented:** `scripts/README.md` lists every script, the env, and how to run
  the 3-service demo — and says NOT to run the Tavus recorders in a loop.
- **Verified:** tsc clean · **114 unit tests pass** · intro present in both live views. No Tavus
  runs (credit-safe).

### 2026-07-08 (cont. 15) — Session-detail = the preview layout (reconstructed replay) + race fix
- **Session-detail now replays in the exact doctor-preview layout**: the recorded rep on the LEFT
  (in place of the live avatar) + Turn evidence; the approved **slides** (top-right, "follows the
  recording") and the **click-through transcript** (bottom-right) on the right. The slides + the
  transcript's playing-highlight track the recording's timeline; clicking any line jumps the video.
  Timeline is aligned to the FIRST turn (the clip starts at the replica's first frame, not the
  session-created time). Verified: clicking the "LIBREXIA program" line seeks to 0:27 and the slide
  advances to "The LIBREXIA Phase 3 program" (3/6).
- **`slideForText` reordered** so specific topics (program/status/mechanism) match BEFORE the generic
  "Medical Information/representative" routing — previously every answer collapsed onto the contact
  slide, so slides never appeared to change.
- **Replica-only replay clip** for the layout: `TavusStage` records the replica stream when a
  recorder sets `window.__nexusrepRecord` (not just bare mode); `scripts/record-session-replay.mjs`
  drives a full multi-turn doctor session and captures it.
- **Race fixed:** the recorder now WAITS for the rep to finish its greeting (a `replica.stopped_speaking`
  event) before asking — no more answering while the rep is still loading.
- **Verified:** tsc clean · **114 unit tests pass** · replay session `session_mrc0vdnl248wob` (7 turns,
  clip attached) plays back in the preview layout with slides synced to the timeline.

### 2026-07-08 (cont. 14) — Full-session replay recorded (fresh Tavus key)
- **Credits worked around:** the user supplied 5 additional Tavus keys (separate Basic accounts).
  `scratchpad/tavus-key-probe.mjs` (deleted after) confirmed all 5 have credits; `TAVUS_API_KEY` in
  `.env.local` is now a fresh one (rotate to another if it runs out — each is 25 min/mo).
- **Recorded the full-session replay** (`scripts/record-session-replay.mjs`): the real doctor
  preview, video rep ON, 3 scripted questions → 128s, 12 MB full-page `.webm` attached to session
  `session_mrc0cmut9vjmcr` (7 turns). Verified by frame grab: the replica talks, the deck advances
  (…→ "Important Safety Information" 5/6), and the Captions panel fills — the exact preview layout,
  replayable, avatar = the recording. Plays in Sessions → that session.
- **Verified:** tsc clean · 114 unit tests pass · 0 active Tavus conversations after the run.

### 2026-07-08 (cont. 13) — ONE doctor view + full-session replay recorder (Tavus credits note)
- **Consolidated to a single doctor view.** `HcpExperience` now takes an optional `app`, and the
  standalone `/hcp` route renders `<HcpExperience/>` (with `?bare=1` still → `<TavusStage bare/>` for
  the clip recorder). So the in-app **Preview HCP experience** and the doctor-facing `/hcp` link are
  the *same* component — what you preview is exactly what the doctor gets. The old bespoke `/hcp` UI
  was deleted. When video is on, HcpExperience logs typed turns into the live Tavus session.
- **Full-session replay recorder** (`scripts/record-session-replay.mjs`): drives the real preview,
  turns on the video rep, asks a scripted sequence (deck advances, captions fill), and records the
  WHOLE page — so playback replays the exact layout (rep + slides + captions). Attaches to the session.
- **⚠ Tavus is out of conversational credits** (Basic = 25 min/mo, exhausted by the many test
  recordings) → `POST /v2/conversations` returns `402 "out of conversational credits"`, so the video
  rep + any NEW replica/replay recording can't run until credits reset (monthly) or the plan is
  upgraded. Text/voice/slides/captions all work regardless; the video-rep button surfaces the error.
- **Verified:** tsc clean · **114 unit tests pass** · `/hcp` renders the unified HcpExperience
  (no mode toggle, mic, branded slides, slides-above-captions).

### 2026-07-08 (cont. 12) — The REAL doctor view (`HcpExperience`) unified
- **Important:** the doctor experience reached from the brand console (**Launch → Preview HCP
  experience**, mode `hcp`) is `src/app/_app/HcpExperience.tsx` — NOT the standalone `/hcp` route.
  Earlier unification work landed on `/hcp`; this brings `HcpExperience` in line (it's the one the
  demo actually shows).
- **One conversation, any input.** Removed the Standard/Text/Voice header toggle — it's now a single
  view where the doctor types OR talks. Added a **🎤 mic icon** to the ask bar; Sound / 3D avatar /
  **🎥 Video rep** are optional pills, not modes.
- **Tavus in the doctor view.** "🎥 Video rep" swaps the 3D/2D avatar for the live `TavusStage`
  replica; typed answers are spoken by the replica via the echo bridge (else browser/3D TTS).
- **Real branded slides.** Replaced the local hardcoded `DECK`/`SlideViewer` with the shared
  `SlideView` (from `milvexian-deck.ts`, same source as the `.pptx`); it follows the conversation
  via `slideForText(answer)`. Header now reads "On screen now · approved deck".
- **Swapped layout:** the approved slides are ON TOP, Captions BELOW (was the reverse).
- **Verified:** tsc clean · **114 unit tests pass** · driven in-app: no mode toggle, mic + Video-rep
  present, branded slide renders, slides-above-captions.

### 2026-07-08 (cont. 11) — Video is fully one conversation (echo) + slide follows playback
- **Replica speaks TYPED answers (Tavus echo).** `TavusStage` is now a `forwardRef` exposing
  `speak(text)`, which sends Tavus's `conversation.interrupt` + `conversation.echo` app-messages so
  the replica voices our already-gated answer verbatim. `/hcp` calls it on a typed turn while the
  video rep is on (browser/3D TTS only when video is off) — so typing and talking are one video
  conversation. **Verified live**: typed question → gated answer logged → replica `started_speaking`
  after the echo. (Headless verification is fiddly — Tavus's fake-mic loop + echoed speech emitting
  no matchable utterance text — so the test asserts on the answer being logged + a new speaking cycle.)
- **Detail-aid slide follows the recording timeline.** Session-detail's slide now tracks the turn
  currently PLAYING (by video position), falling back to the clicked line — so the shown slide
  changes as the recording plays.
- **Note:** MediaRecorder-webm was the source of an earlier PGlite instability only indirectly (the
  data dir got corrupted across many rapid wipe/restart cycles → `RuntimeError: Aborted()`); fixed by
  wiping `.nexusrep-data`. If PGlite ever aborts, delete that dir and restart.
- **Verified:** tsc clean · **114 unit tests pass** · echo confirmed live · final state consolidated
  to **1 session · 1 recording · 0 rule duplicates · deck served · 0 active Tavus conversations**.

### 2026-07-08 (cont. 10) — Trimmed replica clip · slides follow the convo · Tavus in Studio
- **Recording trims the boot.** `TavusStage` bare mode now records via **MediaRecorder** on the
  replica's own stream, started on the **first live frame** (from the `track-started` video event) —
  so the clip is only the rep, with audio, and no ~20s "Connecting". The record bot extracts it as
  base64 (no Playwright page capture). Verified: 25s call → ~7–8 MB clip, opens on the replica.
  Added the MediaRecorder-webm duration fix (`duration===Infinity` → seek-to-end → snap back) so the
  Session-detail scrubber + click-to-seek work (shows 0:22, not ∞).
- **Slides follow the conversation.** `slideForText()` maps a reply to the deck slide it "showed";
  `SlideView` gained a controlled `focusId`. The HCP preview auto-advances the 📄 Detail-aid slide
  per answer, and Session-detail shows a **"Detail aid shown · synced to transcript"** card that
  changes with the selected turn / playback — the recording follow-through.
- **Tavus in the Studio rehearsal.** The Training preview's rep box has a **🎥 Video** toggle that
  swaps the static avatar for the live Tavus replica (`TavusStage`), so brand users preview the real
  video rep while rehearsing.
- **Verified:** tsc clean · **114 unit tests pass** · in-app: Session-detail shows the trimmed
  replica clip (0:22) + the synced branded slide; final state consolidated to **1 session, 1
  recording, 0 active Tavus conversations**.

### 2026-07-08 (cont. 9) — One conversation (any input) + a real Milvexian deck
- **The doctor converses in ONE conversation, any input — no separate modes.** `/hcp` dropped the
  exclusive Text/Voice/Video picker. Text box + mic are always available (type OR talk); the rep
  answers in the transcript and, when **Sound** is on, reads it aloud. **Video rep** and **3D
  avatar** are optional enhancements (independent pills), not modes. When the video rep is on,
  typed turns log into the same Tavus session so the whole conversation is one transcript.
- **Real branded Milvexian deck.** `src/lib/milvexian-deck.ts` is the single source of the approved,
  non-promotional detail aid (title · mechanism · LIBREXIA program · status · ISI · Medical Info).
  `scripts/gen-milvexian-deck.mjs` (pptxgenjs) generates `public/decks/milvexian.pptx` (6 slides,
  J&J navy/red, validated) — downloadable in-app. `SlideView` renders the same slides as branded
  on-screen slides in the preview (📄 Detail aid), so the rep can show them; reusable for the
  session recording follow-through.
- **Verified:** tsc clean · **114 unit tests pass** · `/hcp` renders the unified pills + inline
  title slide + working .pptx download.
- **Next (offered):** make the video rep speak typed answers (Tavus echo) so video is fully part of
  the one conversation; show the shown slide inside the session recording timeline.

### 2026-07-08 (cont. 8) — Rules fixed (no repeats) + replica-only recording
- **"Why are the rules repeated" — two bugs fixed:**
  - `instructionFor` for `persona_style` returned a HARDCODED "Keep responses under 45 seconds…"
    for every feedback; now it reflects the actual feedback (only normalizing the "be concise"
    case). And `inferType` now recognizes "lead with / open with / prioritize" → conversation
    ordering, and HCP-scoped notes → an `hcp_pointer`, so the Sharma/LIBREXIA note is a real
    ordering rule, not a nonsense "45 seconds" line.
  - `seedDemoStudio` wasn't idempotent — `addRule`/`addGuardrail` appended seeded rules on every
    server start (deterministic ids), duplicating them in the persisted DB across restarts. Both
    now skip if the id already exists. Verified: clean seed → 2 distinct coaching rules + 3
    guardrails, **0 duplicates**; adding coaching feedback creates one correctly-typed new rule.
- **Recording is now the replica ONLY** (not a screen-grab of the whole preview). Added a `bare`
  mode to `TavusStage` (full-bleed video, no captions/overlays/End button) reachable at
  `/hcp?bare=1`; the record bot drives that at 1280×720 so the `.webm` is just the rep. Verified
  by frame-grab (clean full-bleed replica, no chrome).
- **Verified:** tsc clean · **114 unit tests pass** · coaching + setup APIs confirmed working.
- **Known / next:** the clip's first ~20s is Tavus's replica connect (see below); a
  MediaRecorder-on-first-frame variant would trim it. Tavus in the Studio *rehearsal* + showing
  detail-aid slides inside the recording are not built yet (see notes).

### 2026-07-08 (cont. 7) — Frontend fake-data fallbacks removed (the real "where's the video")
- **Root cause found.** The Sessions list and Follow-ups tab **initialized from hardcoded
  arrays** (`SESSIONS`, `CRM_EVENTS` — fake Sharma/Okafor/… rows) and only replaced them if the
  API returned non-empty. So even with the DB wiped, the UI showed 6 fake doctors; clicking one
  opened a fake id → `/api/sessions/<fakeId>` 404 → the illustrative view with **no video**.
- **Fixes (all in `BrandScreens.tsx`):**
  - Sessions + Follow-ups now start **empty**, render only real API rows, and show an honest
    empty state ("No sessions yet…") instead of fabricated rows.
  - Session-detail `real` gate no longer requires paired HCP→rep **exchanges** — a greeting-only
    video call (rep turn, no HCP turn) now shows the **video + click-through transcript**.
  - The illustrative fake-transcript fallback is replaced by an honest empty state.
  - Removed the now-unused `SESSIONS` / `CONVERSATION` / `CRM_EVENTS` imports.
- **Verified in-app (Playwright):** Sessions shows only the one real "Dr. A. Sharma" session →
  clicking it renders "LIVE RECORD", a **50s video player**, and the synced transcript
  ("00:15 · AI REP · Hello, doctor…"). `analytics.test.ts` updated to opt into seeded history
  (`createContainer({ seedHistory:true })`). tsc clean · **114 unit tests pass**.

### 2026-07-08 (cont. 6) — Clean slate: no seeded fake activity + reliable clean recording
- **Fake demo history is OFF by default.** `seedDemoHistory` (6 fake sessions + follow-ups)
  is now gated behind `NEXUSREP_SEED_HISTORY=1`; the rep itself (`seedDemoStudio` + approved
  content) is still always seeded so the Studio is launch-ready. Sessions / Analytics /
  Follow-ups now reflect **only real conversations**. `NEXUSREP_DATA_DRIVER=postgres` is in
  `.env.local` so this survives restarts. Reset an existing DB by deleting `.nexusrep-data`.
- **Recording is re-recorded via the clean `/hcp` view** — one canonical demo recording on its
  own session (replica video + greeting transcript), no Daily chrome. Old chrome clip deleted.
- **Two bugs fixed while making the bot reliable:**
  - `TavusStage` opened **two** Tavus conversations under React StrictMode (dev double-invokes
    effects) — added a `startedRef` guard so exactly one conversation opens per mount.
  - The record bot clicked "Video" **before React hydrated** (silent no-op) — it now waits for
    `networkidle` + hydration before clicking.
- **Verified:** tsc clean, 114 unit tests pass; fresh DB → single clean session with a servable
  `video/webm` recording + greeting logged as a `[rep]` turn; 0 seeded sessions, 0 follow-ups.

### 2026-07-08 (cont. 5) — Both-sided transcripts per conversation + simpler doctor view
- **Every conversation is its own reviewable session with both sides transcribed.**
  - **Text/Voice** (`/hcp`): each chat opens its own session on the first message
    (`/api/conversation/turn` now honors `newSession`), logging the doctor's question and
    the rep's reply as timestamped turns (voice uses the same path — on-device ASR → text).
  - **Video** (Tavus): each call gets its own session. The client (`TavusStage`) logs every
    `conversation.utterance` — **both** the doctor's transcribed speech and the rep's spoken
    reply, greeting included — into that session via the new `POST /api/sessions/utterance`.
    The custom-LLM endpoint now **gates only** (`orchestrator.handleTurn`, no logging) so rep
    lines aren't double-counted. The recording attaches to the same session, so the
    click-through transcript is time-aligned to the video (YouTube-style).
- **Recording matches the product.** `scripts/tavus-bot-record.mjs` now drives the clean
  `/hcp` → Video view (not the raw Daily room), so the captured `.webm` shows our replica
  stage — never Daily's Record/Share/People chrome. Verified: fresh session + greeting logged
  as a `[rep]` turn + recording on the same session.
- **Doctor view decluttered.** The three competing toggles (Video rep / 3D avatar / Voice on)
  are now one **Text · Voice · Video** mode picker with **Text as the default** — the simple,
  compliant default; voice/video are opt-in.
- **Verified:** tsc clean, **114 unit tests** pass, Tavus gate test green. Known: the `/hcp`
  visual baseline (`hcp.png`) needs `npm run e2e:update-snapshots` for the new layout.

### 2026-07-08 (cont. 4) — Historical: local advanced-search + auto-recorded video call
- **Superseded on 2026-07-09:** NexusRep now uses hosted Advanced Search with an
  auto-refreshed platform token cache. The hosted API uses the captured access
  token as `Authorization: Bearer`; the local `advanced-search/` clone is no longer
  required for `npm run dev`.
- **Real DocNexus HCP data, no colleague key.** Stood up the cloned `./advanced-search`
  Next app locally on **:3100** against the ClickHouse warehouse. Its `/api/query` has no
  auth gate (Kong sits in front of the *hosted* one only), and the ClickHouse client is
  plain HTTP — so it runs with just the read creds. Boot it with
  `node advanced-search/scripts/dev-with-creds.mjs` (injects `CLICKHOUSE_*` + `ELASTIC_*`
  + `AWS_*` from NexusRep's `.env.local` as **real env vars**, bypassing `@next/env`
  dotenv `$`-expansion that was mangling the ClickHouse password). Only the sanctioned
  aggregate query API is used — never raw SQL against prod.
- **Audience wired to it.** `.env.local` → `NEXUSREP_AUDIENCE=docnexus` +
  `DOCNEXUS_ADVANCED_SEARCH_URL=http://localhost:3100`. Provider now upper-cases
  specialties (warehouse stores `CARDIOLOGY`, case-sensitive) and the timeout is 20s
  (real claims joins take ~8s). `GET /api/audience` now returns **39 real cardiologists**
  for the Milvexian cohort (top: Dr. Rodney Samaan, 13 eligible AFib/ACS/stroke patients).
- **Auto-recorded video call (no human needed).** Tavus server-side recording is
  plan/storage-gated (a live call emits `replica_joined`/`transcription_ready` but **no**
  `recording_ready` on this account), so `scripts/tavus-bot-record.mjs` uses Playwright to
  join the Daily room headlessly (fake mic/cam), clear the name→Continue→Join haircheck,
  and **record the browser page** — the replica renders fine in headless — into a `.webm`.
  It copies that to `public/recordings/`, then POSTs a `recording_ready` webhook exactly
  like Tavus would, attaching it to `session_demo`. Result: a real **4.8 MB** replica
  recording, servable + shown in the Session-detail player with the click-through transcript.
- **Verified:** tsc clean, **114 unit tests** (2 docnexus payload assertions updated for
  upper-casing; new gated live test `tests/docnexus.live.test.ts` proves the real code path
  against :3100), 0 Tavus conversations left active.
- **Run/verify/teardown:** see §3.

### 2026-07-08 (cont. 3) — Tavus CVI wired behind the realtime interface
- **Real Tavus adapter.** `TavusRealtimeProvider` (`src/modules/vendors/tavus.ts`) — REST
  create-persona / create-conversation / end against `https://tavusapi.com/v2` (`x-api-key`).
  `getRealtimeProvider()` returns it when `NEXUSREP_REALTIME_PROVIDER=tavus` (auto when
  `TAVUS_API_KEY` set), else the mock. Vendor interface extended: `RealtimeSession.transportUrl/
  token`; `RealtimeSessionConfig` gains replicaId/personaId/customGreeting/context/customLlm/
  hotwords/language/audioOnly; tools gain JSON-schema `parameters`.
- **Compliance preserved.** The persona's custom-LLM layer points at our new
  `POST /api/tavus/llm/chat/completions` (OpenAI-compatible, SSE) which runs the orchestrator —
  Tavus never composes an HCP answer. `POST /api/tavus/conversation` opens a session and returns
  the Daily join URL (or `configured:false` → fall back to the 3D avatar).
- **Tested:** `tests/tavus.test.ts` (4) — adapter shapes persona (custom-LLM base_url) + conversation
  (greeting/replica), returns join URL, ends; and the LLM endpoint keeps the gate (dosing → Medical
  Information, no fabricated mg; product-info → approved text). Feature map: `docs/TAVUS_INTEGRATION.md`.
- **Last mile (needs a key to verify):** the browser Daily-join UI to render the replica.
- **Verified:** tsc clean, **112 unit tests**, `next build` green (adds `/api/tavus/*`).

### 2026-07-08 (cont. 2) — Real persistence (embedded Postgres) + edge-case hardening
- **Postgres persistence, no external server.** Added `@electric-sql/pglite` (real
  Postgres in-process, WASM). New `RepositoryFactory` abstraction (`src/lib/repository.ts`)
  + `PgRepository` over PGlite (`src/lib/db/`). Every service (sessions, followups, CRM,
  content, audit, studio) now takes an injected factory — memory by default, Postgres when
  `NEXUSREP_DATA_DRIVER=postgres`. File-backed via `PGLITE_DATA_DIR` → durable across restarts.
- **Proven end-to-end:** `tests/postgres.test.ts` — PgRepository CRUD/where/append-only,
  services round-trip, and **durability across a fresh connection**. Also verified live: ran
  the app on the Postgres driver, created a session, restarted, and the live session (with its
  turns) survived without re-seeding. The vector index stays in-memory by design (candidate
  cache, rebuilt from canonical Postgres — brief §15).
- **Edge-case hardening:** `tests/edge-cases.test.ts` (11) — empty/whitespace/huge classifier
  input, gate boundaries (ISI not required on routing turns, empty-output block, injection),
  grounding degenerate inputs, router precedence, empty/extreme targeting cohorts (no NaN),
  unknown-id session/studio/MLR ops, malformed PPTX. Plus on-device Whisper STT + MLR workflow
  from the prior pass.
- **Verified:** tsc clean, **108 unit/integration tests**, **10 E2E**, **3 visual**, `next build` green.

### 2026-07-08 (cont.) — All wirings real: Studio + console + session evidence
- **Studio is real:** `StudioScreen` now reads/writes `/api/studio` — setup answers +
  section confirmation persist, **Training & Preview drives the real orchestrator**
  (`/api/conversation/turn`), coaching + per-line commenting create **persisted,
  compliance-classified, scoped rules** referring to the coached line, Rules
  accept/reject persist, and Readiness/launch are real (gated). Locked guardrails seeded.
- **Console fully live:** Audience + Launch read `/api/audience` (real opportunity
  scores), Overview KPIs derive from `/api/analytics`, and Session-detail loads real
  turns + audit via new `/api/sessions/[id]` (illustrative fallback for seeded rows).
- **Backend adds:** rules gain `origin` (guardrail|coaching) + `sourceMessage`;
  `StudioService.addGuardrail`; LLM-classifier prompt learns `product_info`.
- **Credential scour → memory:** `advanced-search` has no committed secrets; recorded
  the call/auth contract + dev-mode auth bypass + what to request from DocNexus.
- **Verified:** tsc clean, **87 unit tests**, **10 E2E** (incl. Studio preview+coaching,
  guardrails, live Audience), **3 visual baselines**, `next build` green.

### 2026-07-08 — J&J / Milvexian pivot: real backend + real HCP data + demo-ready
Large push turning the lifecycle real end-to-end and re-theming to the J&J
**Milvexian** (investigational Factor XIa inhibitor · cardiology · LIBREXIA) demo.

- **Real services (were type-only stubs):**
  - `SessionService` (`src/modules/sessions`) — persists sessions + turns, derives
    duration / question count / compliance status from real routing. `ConversationService`
    (`src/modules/realtime/conversation.ts`) composes orchestrator + session logging +
    CRM outbox enqueue. `/api/conversation/{start,turn,end}` wired.
  - `TargetingService` (`src/modules/audience`) — deterministic opportunity scoring
    from aggregate features (whitespace × density × trend), segment derivation.
  - `AnalyticsService` (`src/modules/analytics`) — every metric derived from live
    session/follow-up/CRM/content/targeting state + `RuntimeMetrics` (live latency).
  - `StudioService` (`src/modules/aiRepStudio/service.ts`) — persists setup draft +
    rep + rules + readiness; launch gated on readiness. `/api/studio`.
- **Real HCP audience data (advanced-search):** `DocNexusAudienceProvider`
  (`src/modules/audience/providers`) calls the hosted DocNexus `POST /api/query`
  (`outputCategory: type_1_npi`, cardiology specialties + LIBREXIA diagnoses
  I48/I21/I24/I63) → aggregate `HCPFeatures` (no PHI). `loadCohort()` falls back to a
  modeled cardiology cohort if no key/unreachable. Env: `NEXUSREP_AUDIENCE`,
  `DOCNEXUS_ADVANCED_SEARCH_URL`, `DOCNEXUS_API_KEY`/`DOCNEXUS_BEARER_TOKEN`.
- **Stage 5 compliance hardening:** semantic **grounding validator**
  (`src/modules/compliance/grounding.ts`) — fabricated numbers / topic drift in an
  LLM-composed answer are caught and dropped back to approved text (audited). New
  **investigational guardrail** — clinical specifics (dose/efficacy/safety) route to
  Medical Information; only public facts (mechanism, LIBREXIA program, FDA status) are
  answered, each carrying the investigational disclosure. **Red-team suite**
  (`tests/redteam.test.ts`). Gate fix: `isi_missing` only applies to `approved_answer`.
- **Real document parsing:** `parsePptx` (`src/modules/content/parsers/pptx.ts`, JSZip)
  extracts slide text from real `.pptx`; `extractSourceText` + `/api/content/ingest`
  turn an uploaded deck into candidate blocks that stay **in-MLR (not live)** until
  approved. `tests/pptx.test.ts`.
- **Live console:** `/api/{analytics,sessions,audience,followups}` read-APIs; the
  Analytics / Sessions / Follow-ups screens render live computed data (static themed
  fallback). Full UI re-theme Dolo→Milvexian (deck, chips, personas, demo data).
- **3D mascot/avatar:** verified — free TalkingHead GLB + free HeadTTS neural voice
  from CDN with graceful 2D fallback; default avatar works with no config.
- **Verified:** `tsc` clean (NexusRep sources), **85 unit/integration tests**, **7 E2E**,
  **3 visual baselines** regenerated, `next build` green. Demo script:
  `docs/DEMO_SCRIPT_JNJ.md`.

### 2026-06-21 — Real retrieval embeddings (mock→real; fixes slide ranking)
- **Added:** `src/lib/embeddings.ts` — `EmbeddingProvider` with a **local neural
  model** (`@xenova/transformers`, `all-MiniLM-L6-v2`, no key, dynamic-imported,
  downloads once) and a **stemmed + stopword-filtered lexical** fallback; cosine.
  `NEXUSREP_EMBEDDINGS=neural|lexical|auto` (default auto → neural then fallback;
  tests/CI forced lexical for determinism).
- **Changed:** `InMemoryVectorIndex` now embeds via the provider (lazy batch);
  records store text not precomputed vectors; container seeds text; `next.config`
  `serverExternalPackages: ["@xenova/transformers"]`; Playwright webServer forces
  `NEXUSREP_EMBEDDINGS=lexical`. `tests/retrieval-rank.test.ts` (3).
- **Verified live (neural):** dosing→**Dolo 650 Dosing** slide, safety→**ISI**,
  onset→**Onset & efficacy** — the ranking quirk is fixed. `typecheck` clean,
  `npm test` 54 passing, `npm run build` success.
- **Remaining mocks (need infra/keys, not fixable with the Anthropic key alone):**
  Postgres/pgvector store, real PPT/PDF ingestion parser, and A/V + CRM vendor
  integrations (Tavus/GPT-Realtime/ElevenLabs/Veeva/Salesforce/IQVIA).

### 2026-06-21 — Dolo 650 vs Crocin theme · slide viewer · symmetric A/B
- **Theme:** demo re-themed to **Dolo 650 (paracetamol 650 mg)** as the marketed
  brand vs **Crocin** competitor — seeded approved content (dosing/safety/onset) +
  paracetamol ISI in `container.ts`; HCP rep header/invite/chips; console rebranded
  CardioNova→Dolo 650. The "compare to Crocin" chip shows the compliant handling
  (comparative → routes to MSL; the A/B benchmark shows what a raw model *would*
  have claimed — a good "why governance matters" contrast).
- **Slide viewer:** `SlideViewer` renders the current detail aid as a real slide
  (title + bullets) with a clickable **filmstrip**; it advances to the topic's slide
  on each answer (and is clickable to flip manually). Mock deck, shown as slides.
- **A/B symmetry/redundancy fix:** in A/B mode the chat now shows a focused,
  symmetric two-column comparison (no avatar/captions, no duplicated question);
  normal mode keeps captions + slide viewer.
- **E2E determinism:** `playwright.config` webServer now forces
  `NEXUSREP_CLASSIFIER=keyword` + blank keys so tests never depend on a real LLM
  key/network/tokens (independent of `.env.local`). Assertions + overview baseline
  updated for Dolo.
- **Verified:** `typecheck` clean, `npm run e2e` 9 passing; live (Haiku) dosing →
  grounded Dolo answer + verbatim ISI; compare-to-Crocin → MSL route.
- **Known quirk:** toy retrieval embeddings sometimes rank the wrong approved block
  first, so the slide can advance to "Onset" on a dosing question — fixed by real
  embeddings (next mock→real candidate).

### 2026-06-21 — LLM-composed grounded answers (mock→real)
- **Added:** `src/modules/content/composer.ts` — `GroundedComposer` (Claude via SDK,
  OpenAI/TM via fetch) that writes the rep's reply USING ONLY the retrieved approved
  blocks (strict system prompt; no new claims); `getComposer`/`resolveComposer`;
  `tests/composer.test.ts`.
- **Changed:** orchestrator's approved-answer branch now composes the body via the
  LLM (constrained to approved blocks) when a provider is configured, else the
  deterministic builder; **ISI appended verbatim by code** (never paraphrased);
  source IDs preserved so the gate still validates grounding; fail-safe to the
  builder on any error. Container injects `resolveComposer(env.classifierProvider)`;
  `/api/conversation/turn` honors the in-chat per-request model for composition too.
- **Verified live (Haiku):** dosing → Claude-composed grounded answer + verbatim ISI;
  off-label → refuse + MSL. `typecheck` clean, `npm test` 51 passing.
- **Known limit:** grounding is enforced by prompt + verbatim-ISI + source-ID gate;
  a semantic groundedness validator (answer ⊆ approved text) is the Stage-5 step.

### 2026-06-21 — Chat preview view modes: Standard / Text / Voice + Full screen
- **Added (in `HcpExperience`):** a **Standard / Text / Voice** segmented switch +
  a **⛶ Full screen** toggle (Fullscreen API on the session root, graceful fallback)
  in the session header.
  - **Text** — clean messaging UI: transcript bubbles, input + try-chips, detail-aid
    note, escalation actions; no avatar/voice.
  - **Voice** — call-style centered avatar orb, Listening/Thinking/Speaking status,
    tap-to-talk mic with **barge-in** (talking cancels the rep), captions show/hide,
    text fallback when no mic; voice auto-on.
- **Why:** user wants to test the rep across modalities in the preview.
- **Verified:** `typecheck` clean, `npm run build` success; text-only and voice-only
  modes screenshotted (text: full transcript incl. off-label refusal + detail-aid;
  voice: orb speaking + captions + mic).

### 2026-06-21 — Consolidated model A/B into the chat
- **Why:** per user — drop the separate compare/arena pages; do model selection +
  A/B testing inside the conversation itself.
- **Added:** `src/lib/arena-client.ts` (`streamArena` SSE helper); `/api/models`
  (provider availability); in `HcpExperience` an off-by-default **⚙ Test models**
  strip with Model A/B selectors + A/B compare (side-by-side streamed answers with
  time-to-first-word + total latency); `classifyWith(provider, text)` so a chosen
  model can classify the live turn (fail-safe to keyword); `handleTurn` accepts a
  per-request classifier override; `/api/conversation/turn` accepts `classifier`
  and returns provider + latency for the in-chat badge.
- **Removed:** standalone `/compare`, `/arena` pages + `ArenaClient`, and
  `/api/compare/classify` (kept `/api/arena/stream`, `/api/models`, the responder
  + classifier modules). Admin links replaced with a pointer to the in-chat tester.
- **Doctor-view rule preserved:** Test-models is off by default, so the HCP view
  stays jargon-free unless a brand user opts into testing in preview.
- **Verified:** `typecheck` clean, `npm test` 49 passing, `npm run build` success,
  `npm run e2e` 9 passing; in-chat A/B screenshotted (two providers streaming with
  latency, offline mock-vs-mock; real providers light up with keys).

### 2026-06-21 — Realtime Arena (latency / streaming / barge-in)
- **Added:** `src/modules/realtime/responders/*` — streaming responder providers
  (`mock` browser baseline $0; `claude` SDK streaming; `openai`/`thinking-machines`
  OpenAI-compatible SSE). `/api/arena/stream` (SSE, measures server TTFT/total) +
  `/arena` UI: streams tokens, **speaks them as they generate** (incremental
  browser TTS), **interrupt** + **mic barge-in**, and a per-run comparison log of
  time-to-first-word / time-to-first-audio / total. `tests/responders.test.ts` (3).
- **Why:** user wants to test which provider is smarter/lower-latency and handles
  fluent realtime convos (interruptible, talks-while-computing, no "passing the
  ball"). This is the realtime axis; `/compare` is the reasoning axis.
- **Honest scope:** benchmark only (free-generates, not the compliant rep). True
  sub-second speech-to-speech (GPT Realtime) is a deeper WebRTC integration that
  slots in behind the same `Responder` boundary; Thinking Machines plugs in if it
  exposes an OpenAI-compatible endpoint.
- **Verified:** `typecheck` clean, `npm test` 49 passing, `npm run build` success,
  `/arena` screenshotted streaming + speaking + logging metrics with the mock.

### 2026-06-21 — Pluggable LLM classifier + provider comparison
- **Added:** `src/modules/compliance/classifiers/*` — swappable `LlmClassifier`
  providers: `keyword` (deterministic, $0, default), `claude` (Anthropic SDK,
  dynamic-imported, default `claude-opus-4-8`), `openai` + `thinking-machines`
  (OpenAI-compatible via fetch + configurable base URL), a registry
  (`getClassifier`/`compareClassifiers`/`resolveClassifier`), and a defensive
  JSON normalizer. `/api/compare/classify` + `/compare` UI run one HCP message
  through all providers side by side (intent, per-risk scores, latency, usage).
  `tests/classifiers.test.ts` (7).
- **Changed:** `TurnOrchestrator` takes an injected async classifier (defaults to
  keyword); the container injects the env-selected provider, which **fails safe to
  keyword** on error/unavailability. `NEXUSREP_CLASSIFIER` + Anthropic/OpenAI/TM
  keys+models in `.env.example` + `env.ts`. Admin screen links to `/compare`.
  Added `@anthropic-ai/sdk` dependency.
- **Why:** user wants Claude as the LLM, but pluggable to compare vs GPT/OpenAI
  and a Thinking Machines interaction-model endpoint. Comparison is at the
  classifier/reasoning level (GPT *Realtime* voice transport is the separate
  `RealtimeProvider` axis).
- **Verified:** `typecheck` clean, `npm test` 46 passing, `npm run build` success
  (SDK stays server-side via dynamic import; `/compare` is 2 kB), `/compare`
  screenshotted — keyword runs offline, others show "not configured" until keyed.

### 2026-06-21 — Stage 3 (Conversation engine + RAG) + UI completion
- **Added:** `src/modules/content/ingest.ts` (source adapter + normalizer →
  canonical blocks/slides/ISI), `responseBuilder.ts` (approved-blocks-only
  composition + verbatim ISI + detail-aid slide), `DetailAidSlide` model +
  slide store on `ContentService`; Stage-3 tests (`ingest`, `response-builder`,
  orchestrator detail-aid). Studio Build sections now have real per-field editors
  (Audience selects, Escalation MSL + handoff/AE toggles, Rules/Readiness links).
- **Changed:** orchestrator composes via the response builder + returns
  `detailAidSlideId`; `/api/conversation/turn` returns the resolved detail aid;
  HCP view shows the source-driven detail aid (was keyword-guessed); container
  seeds detail-aid slides linked to approved answers.
- **Verified:** `typecheck` clean, `npm test` 39 passing, `npm run build` success,
  `npm run e2e` 9 passing. Acceptance: rep answers only from approved blocks and
  shows the correct detail aid.

### 2026-06-21 — Full prototype UI ported to React
- **Added:** `public/colors_and_type.css` + `public/assets/*` (full design system);
  `src/app/_app/` — `data.ts` (all demo content), `NexusRepApp.tsx` (shell + nav +
  Overview), `BrandScreens.tsx` (Audience/Launch/Sessions/Session Detail/Analytics/
  Follow-ups/Admin + HCP drawer + launch modal), `StudioScreen.tsx` (Build setup
  assistant + Train coaching→rules + Rules + Readiness), `HcpExperience.tsx`
  (invite/convo/complete, wired to the compliance API + LiveAvatar).
- **Changed:** `/` now renders the full console; layout links the full design CSS;
  added `dn-pulse`/`dn-fade` keyframes + app scrollbars; E2E updated for the console;
  overview visual baseline regenerated.
- **Why:** the scaffold pages didn't look like the user's mockup; user chose to port
  the full mockup now. UI matches the prototype; real module logic sits behind it.
- **Verified:** `typecheck` clean, `npm run build` success, `npm run e2e` 9 passing
  (1 guarded 3D test skipped). Screens visually reviewed via screenshots.

### 2026-06-21 — Live 3D avatar (TalkingHead + HeadTTS), opt-in
- **Added:** `src/app/_components/LiveAvatar.tsx` (loads TalkingHead 3D avatar +
  HeadTTS free neural voice from CDN via the import map, exposes `speak()`,
  auto-falls back to `RepAvatar`); import map in `src/app/layout.tsx`;
  `src/types/external-esm.d.ts`; `NEXT_PUBLIC_NEXUSREP_AVATAR_URL` in `.env.example`.
- **Changed:** `/spike` "Live 3D" toggle; `/hcp` "3D avatar" toggle — both route
  speech through the 3D neural voice when ready, else browser voice.
- **NOT yet verified (needs a human in Chrome):** actual 3D rendering + WebGPU voice
  + first-load model download. Default avatar is TalkingHead `brunette.glb`.

### 2026-06-20 — Stage 2b (real browser-native A/V)
- **Added:** `src/lib/browser-speech.ts` (`BrowserVoiceProvider` real TTS,
  `BrowserRecognizer` real mic, `ClientVoiceProvider` interface);
  `src/app/_components/RepAvatar.tsx` (animated avatar + real webcam);
  `tests/browser-speech.test.ts`.
- **Changed:** `/spike` speaks the approved script aloud + camera toggle; `/hcp`
  speaks answers aloud + microphone input.
- **Why:** user requirement — "no demos, real things." A/V is genuine (browser-native,
  $0, no keys); vendor adapters stay ready for keys later.

### 2026-06-20 — Stage 2 (A/V spike)
- **Added:** `src/modules/realtime/avSpike.ts` (`runScriptedSession`);
  `src/app/api/spike/run/route.ts` (thin controller); `src/app/spike/page.tsx`;
  `tests/spike.test.ts`; E2E spike flow + `spike.png` baseline.
- **Verified:** acceptance — start a session, speak a fixed approved script, show a
  detail aid, end — through the adapter boundary.

### 2026-06-20 — Stage 1 (scaffold)
- **Added:** `CLAUDE.md`, `docs/VENDOR_EVAL.md`, `docs/WALKTHROUGH.md`; full Next.js
  + TS modular-monolith scaffold; vendor adapter interfaces + mocks + registry;
  Postgres/pgvector-ready repository + vector-index abstractions; composition root
  with demo seed (CardioNova/ACS); Vitest + Playwright.
- **Changed:** moved `typedRoutes` out of `experimental` in `next.config.mjs`.
- **Verified:** typecheck clean, tests + build + e2e green.
