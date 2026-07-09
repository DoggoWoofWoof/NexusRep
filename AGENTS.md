# Codex Instructions for NexusRep

You are implementing **NexusRep**, an AI-first pharma **AI Rep Studio**. Brands use it to
**build, train, approve, launch, and improve** a compliant AI representative that talks to
healthcare professionals (HCPs).

Do **not** turn the product into a generic CRM, campaign manager, analytics dashboard, or
avatar vendor. It is the pharma-specific orchestration layer that links targeting, approved
content, compliant conversation, auditability, analytics, and CRM handoff.

The product should feel like: _"Train and launch a compliant AI rep for the right HCPs."_

## Core product loop

```
Build the rep → Train the rep → Choose audience → Launch → Improve from sessions
```

Monitoring surfaces (not the center of the product): Overview, Sessions, Analytics, Follow-ups.

## The two AI roles — never mix them

1. **DocNexus Setup Assistant** — *internal* assistant for the brand user. Asks setup questions,
   infers structured setup values, requests uploads (PPT/PI/ISI/FAQ/script), drafts conversation
   rules, populates editable structured sections. It must **never** behave like the HCP-facing rep.
2. **HCP-facing AI Rep** — *outward-facing* compliant digital rep. Approved content only, discloses
   it is AI, stays on-label, delivers ISI when required, refuses off-label, detects adverse events,
   routes to MSL / medical information / pharmacovigilance / human rep, logs every decision, creates
   follow-ups automatically.

## Hard rules (non-negotiable)

- Approved content only. No generated medical, dosing, efficacy, safety, comparative, or promotional claims.
- Off-label questions must be **refused and routed**.
- Adverse-event (AE) mentions must route to **pharmacovigilance**.
- ISI must be delivered **verbatim** when required.
- Raw **patient-level** claims must never enter live conversation context or reach third-party
  AI/avatar/TTS/ASR vendors. Only HCP-level aggregate features are allowed.
- CRM is an **automated backend handoff**, surfaced through Follow-ups — not a major manual tab.
- **Every** response must pass the **final compliance gate** before output.
- Fail safe: when classification, retrieval, or validation is uncertain → refuse, escalate, or use an approved fallback.

## Architecture

- **Next.js (App Router) + TypeScript**, structured as a **modular monolith** with clean service
  boundaries so modules can be split into services later without changing business logic.
- **Business logic does not live in React components or API route files.** API routes are thin
  controllers that call into `src/modules/*`. Components render; modules decide.
- All external sources and vendors go through **adapters**. Core services depend only on canonical
  NexusRep objects — never on raw CRM payloads, PPT/PDF structures, or vendor-specific API formats
  (Tavus, GPT Realtime, ElevenLabs, etc.).
- **Postgres is the canonical source of truth.** Vector retrieval only returns candidate IDs;
  source validation + the compliance gate decide eligibility. The vector index is never product truth.
- Realtime / avatar / voice / CRM / retrieval providers must be **swappable** behind interfaces.
  Mock vendors first, but keep the interfaces real.
- Storage abstractions must be **Postgres/pgvector-ready** even while the first version uses
  mocked/in-memory data.

### Module map (`src/modules/*`)

`auth` · `tenants` · `setupAssistant` · `aiRepStudio` · `content` · `mlr` · `audience` ·
`targeting` · `sessions` · `training` · `rules` · `retrieval` · `compliance` · `realtime` ·
`vendors` · `audit` · `analytics` · `followups` · `crm`

Each module owns its domain types, repository interface, and service logic. Cross-module access
goes through a module's public surface (its `index.ts`), never by reaching into another module's internals.

### Canonical data flow

```
Any approved source in
  → one canonical internal data model
  → one controlled, latency-aware agent graph
  → one compliance gate before output
  → any CRM or AI vendor out
```

Runtime turn (HCP):

```
HCP input → ASR/input adapter → combined intent/risk classifier → policy router
  → (approved retrieval | refusal | AE/PV | MSL | human handoff | fallback)
  → retrieval + source validation → response builder → response validator
  → final compliance gate → avatar/TTS/detail-aid output → audit + metrics + follow-up/CRM event
```

Latency-aware: combine intent/off-label/AE/medical-info/prompt-injection detection into one
classifier where possible; run retrieval + risk classification in parallel when safe; keep
validation deterministic (MLR status, expiry, audience, campaign, exact ISI, source IDs); move
deep QA / summaries / analytics aggregation async. **If speed conflicts with compliance, fail safe.**

## Doctor / HCP view

Separate from the brand UI. The doctor must **never** see internal jargon: no sidebar, Platform
Admin, demo toggle, MLR IDs, CRM, runtime/compliance-gate language, agent graph, JSON, or internal
rules. Use simple language ("Checking approved information…", "A representative can contact you.").

## Testing

- Unit tests (Vitest) for core logic: adapters, normalizers, content versioning, MLR status checks,
  retrieval filters, response validation, compliance gate, CRM outbox, rule generation/scoping,
  setup-assistant field inference.
- Integration tests for the key flows (content→retrieval→gate→output, off-label→refusal→MSL,
  AE→PV, session end→follow-up→CRM outbox).
- **Playwright E2E** (`e2e/nexusrep.spec.ts`) covering build, train, train-from-session, compliance,
  audience, launch, follow-ups.
- **Playwright visual regression** for major screens. Visual checks must catch `[object Object]`,
  header clipping, hidden tabs, overlapping controls, cramped tables, and the doctor view showing
  internal terms.

## Documentation

Maintain **`docs/WALKTHROUGH.md`** after every meaningful implementation step (what changed, files
touched, how to run, how to test, how to demo, known limitations, next steps). The full product
brief lives at `docs/NEXUSREP_IMPLEMENTATION_BRIEF.md`; vendor analysis at `docs/VENDOR_EVAL.md`.

## What not to build

No new dashboards, CRM-export tabs, or campaign-manager surfaces before the core lifecycle
(Build → Train → Audience → Launch → Improve), the compliance engine, and the test suite exist.
