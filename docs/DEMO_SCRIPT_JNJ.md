# NexusRep — J&J / Milvexian demo script

**Audience:** J&J. **Product:** Milvexian (investigational oral **Factor XIa inhibitor**;
Phase 3 **LIBREXIA** — ischemic stroke, ACS, atrial fibrillation; FDA Fast Track; **not approved**).
**Positioning:** train, launch, and improve a **compliant AI rep** for cardiology HCPs —
built for an **investigational** compound and designed to scale to many reps × many HCPs.

---

## 0. Before the room (5 min)

```bash
cd NexusRep
npm install
npm run dev          # http://localhost:3000
```

- **No keys needed** — runs fully on the modeled cardiology cohort + deterministic
  compliance. First HCP question warms an on-device model (~a few seconds), then it's fast.
- **To show LIVE DocNexus HCP data** (optional): set in `.env.local`
  ```
  NEXUSREP_AUDIENCE=docnexus
  DOCNEXUS_ADVANCED_SEARCH_URL=https://advanced-search.docnexus.ai
  DOCNEXUS_ID_TOKEN_FILE=.docnexus-id-token.json
  DOCNEXUS_AUTO_REFRESH_TOKEN=1
  DOCNEXUS_PLATFORM_EMAIL=<email>
  DOCNEXUS_PLATFORM_PASSWORD=<password>
  ```
  The Audience cohort then comes from hosted `POST /api/query` (cardiology + LIBREXIA
  diagnoses I48/I21/I24/I63). NexusRep refreshes the platform token cache when needed
  and sends the hosted API the captured access token as `Authorization: Bearer`.
- Optional: `ANTHROPIC_API_KEY` + `NEXUSREP_CLASSIFIER=claude` for real-LLM
  classification/compose (the compliance guardrails are identical either way).

---

## 1. The core loop (Build → Train → Audience → Launch → Improve)

1. **Overview** — command center themed to the Milvexian LIBREXIA cardiology campaign.
2. **AI Rep → Build** — the DocNexus Setup Assistant has a **persisted** Milvexian rep
   (persona, disclosure, escalation). Point out: *this survives refresh — it's real state.*
   - **Proper content ingestion:** uploads parse for real — a `.pptx` is extracted slide
     by slide (`/api/content/ingest`) and comes back **pending MLR**, never auto-live.
3. **Train** — coaching feedback becomes rules; a competitor-comparison rule is auto-marked
   **blocked_by_compliance** (no approved source). Compliance can't be trained away.
4. **Audience** — cardiology whitespace ranked by a **real opportunity score** (eligible-
   patient density × whitespace × trend), aggregate/no-PHI. *With a DocNexus key this is
   real claims data.* Add HCPs → **Launch**.
5. **Improve** — Sessions / Analytics / Follow-ups all render **live computed** data.

## 2. The digital twin — the HCP conversation (the star)

Open **Launch → Preview HCP experience** (or `/hcp`). This is the compliant AI rep.

Ask these in order — this is the compliance story:

| Ask | What happens | Why it matters for J&J |
|-----|--------------|------------------------|
| **"What is Milvexian and how does it work?"** | Answers from approved public facts (oral FXIa inhibitor) + **investigational disclosure**; on-screen slide advances | Only publicly-disclosed info, sourced |
| **"What's the LIBREXIA program?"** | The three Phase-3 indications; slide advances | Grounded, on-label public info |
| **"What's the recommended dose?"** | **Routes to Medical Information** — not answered | *Investigational guardrail:* no dose/efficacy for an unapproved drug |
| **"How does it compare to apixaban?"** | Routes to Medical Information | No comparative claims |
| **"Can I use it off-label?"** | **Refused → MSL** | Off-label refusal + routing |
| **"My patient had major bleeding after the study drug."** | **Routed to pharmacovigilance** | Adverse-event capture |

Modes to show: **🎙 Voice** (real browser speech), **⛶ Full screen**, **3D avatar on**
(free TalkingHead + neural voice), **⚙ Test models → A/B** (Claude vs baseline in-chat).

## 3. Proof it's real, not a script

- **Sessions** — the session you just ran appears, with its **derived compliance status**.
- **Analytics → Compliance** — ISI/disclosure delivery, MSL routings, AE captures,
  **"0 ungrounded responses"** — all computed from the sessions, not hardcoded.
- **Follow-ups** — the MSL / PV / medical follow-ups you triggered, with CRM outbox status.
- **The guardrails are tested:** 85 unit/integration tests incl. a **red-team suite**
  (prompt injection, fabricated-efficacy → dropped to approved text, off-label, AE,
  investigational routing), 7 E2E, 3 visual. `npm test && npm run e2e`.

## 4. The scale message (tens–hundreds of reps)

- One canonical model → one controlled agent graph → **one compliance gate before every
  output** → any CRM/vendor out. Adding reps/brands is configuration, not new risk.
- Vendors (realtime/voice/avatar/CRM/retrieval) are all behind swappable interfaces —
  mock today, real on a key, **no change to the compliance logic**.

---

## Talking points / FAQ

- **"Is it making medical claims?"** No. For an investigational compound it answers only
  public facts and routes every clinical specific to Medical Information — enforced in code
  (the investigational guardrail + grounding validator + final compliance gate), not by prompt.
- **"Where does the HCP list come from?"** DocNexus claims via hosted Advanced Search (`type_1_npi`),
  aggregate features only — no patient-level data leaves the boundary.
- **"Can it scale?"** Yes — modular monolith with clean service boundaries; each rep is a
  configured persona + approved content set over the same governed runtime.

## Known limitations (say them if asked)
- Live DocNexus data needs platform credentials or a valid token file; otherwise a modeled cardiology cohort (clearly labeled).
- Vendor realtime uses the real DocNexus Agent/Tavus path when `TAVUS_API_KEY` is set;
  Playwright E2E intentionally blanks vendor keys so tests do not spend credits. CRM stays
  a simulated outbox adapter. Postgres/pgvector are ready, with local demos usually running
  on PGlite or memory depending on `.env.local`.
