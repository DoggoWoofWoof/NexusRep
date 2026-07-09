\# NexusRep Implementation Brief for Claude Code



\## 0. Mission



Build NexusRep as an AI-first pharma rep platform, not as a campaign manager, CRM dashboard, or generic chatbot.



The product should feel like:



> Train and launch a compliant AI rep for the right HCPs.



The product should not feel like:



> Configure a campaign, CRM, analytics, compliance console, and avatar vendor manually.



The current UI/prototype direction is acceptable as a visual baseline, but implementation should now focus on product logic, modular architecture, testability, and end-to-end working flows.



\---



\## 1. Current product direction



NexusRep is an AI Rep Studio for pharma and medtech. Brands use it to build, train, approve, launch, and improve a compliant AI representative.



The core product loop is:



```text

Build the rep

→ Train the rep

→ Choose audience

→ Launch the rep

→ Monitor sessions

→ Improve from transcripts and recordings

```



The system must preserve the original core architecture:



```text

Any approved source in

→ one canonical internal data model

→ one controlled latency-aware agent graph

→ one compliance gate before output

→ any CRM or AI vendor out

```



The implementation must stay modular and source/vendor agnostic.



\---



\## 2. Product roles



There are two different AI roles. Do not mix them.



\### 2.1 DocNexus Setup Assistant



This is an internal setup assistant for the brand user.



It helps configure the HCP-facing AI rep by asking questions and inferring structured setup values.



It should:



\* ask setup questions

\* infer product/brand/indication

\* infer target audience

\* infer approved knowledge requirements

\* ask for PPT / PI / ISI / FAQ / script uploads

\* infer escalation contacts

\* infer MSL/human handoff needs

\* suggest required talking points

\* suggest blocked topics

\* draft conversation rules

\* populate structured setup sections

\* allow manual edits through advanced settings

\* never behave like the HCP-facing AI rep



\### 2.2 HCP-facing AI Rep



This is the digital representative that speaks to doctors/providers.



It should:



\* use only approved content

\* disclose that it is AI

\* stay on-label

\* deliver ISI when required

\* refuse off-label questions

\* detect adverse events

\* route to MSL / medical information / pharmacovigilance / human rep when required

\* log every decision

\* create follow-up events automatically



\---



\## 3. Core navigation



Simplify the product around AI Rep Studio.



Recommended navigation:



```text

AI Rep

Overview

Sessions

Analytics

Follow-ups

```



Inside AI Rep, use lifecycle modes:



```text

Build

Train

Audience

Launch

Improve

```



Alternative tab names are acceptable, but the meaning must stay:



| Mode     | Purpose                                                                       |

| -------- | ----------------------------------------------------------------------------- |

| Build    | Setup assistant + rep profile + approved knowledge + escalation + draft rules |

| Train    | Rehearsal / preview with transcript coaching                                  |

| Audience | Select and review target HCPs                                                 |

| Launch   | Resolve blockers and activate outreach                                        |

| Improve  | Train from real sessions and update rules                                     |



Overview should be a monitoring page, not the main setup page.



If the rep is not ready, default the user to AI Rep Studio, not Overview.



\---



\## 4. Overview behavior



Overview should not say “Open AI Rep Studio” if AI Rep is already the primary area.



Overview should behave as a campaign/performance monitoring page.



It should show:



\* AI rep readiness

\* sessions completed

\* target HCPs

\* follow-ups pending

\* content or MLR issues

\* CRM/follow-up issues

\* what HCPs are asking

\* sessions needing coaching

\* compliance/export health



State-based CTA:



```text

If not ready: Resolve launch items

If ready but not live: Launch AI rep

If live: Review sessions needing coaching

```



Keep Overview, Sessions, Analytics, and Follow-ups, but do not make CRM or campaign setup the center of the product.



\---



\## 5. AI Rep Studio: Build mode



Build mode should be assistant-led, not a giant manual form and not a pure chat.



\### 5.1 Layout



Recommended layout:



```text

Left: DocNexus Setup Assistant

Right: Structured setup draft

Bottom or drawer: Advanced/manual edit

```



The setup assistant asks one setup question at a time and populates structured sections.



\### 5.2 Setup assistant questions



The assistant should ask and infer:



\* brand / product

\* therapeutic area

\* indication

\* target audience

\* decile range or whitespace segment

\* specialty

\* launch window

\* approved content available

\* detail aid / PPT

\* prescribing information

\* ISI

\* FAQ / script

\* persona type: brand persona or rep clone

\* avatar/appearance

\* voice style

\* AI disclosure text

\* approved greeting

\* MSL contact

\* human rep handoff

\* AE routing

\* blocked topics

\* required talking points

\* CRM destination or export preference



\### 5.3 Structured setup draft



The assistant should populate editable structured sections:



```text

Rep profile

Approved knowledge

Audience

Escalation \& handoff

Conversation rules

Readiness

```



Each section should have status:



```text

Complete

Needs input

Needs source

Needs MLR

Blocked

```



User actions:



```text

Accept suggestion

Edit manually

Ask assistant to revise

Skip for now

Open advanced settings

```



\### 5.4 Do not remove fields



Fields from the previous UI should not disappear. They should become inferred and editable.



The setup assistant should reduce clicks, not remove capability.



\---



\## 6. AI Rep Studio: Train mode



Train mode is the hero of the product.



The brand user rehearses with the AI rep and coaches it before launch.



\### 6.1 Training layout



Recommended layout:



```text

Left: Live rehearsal

Middle: Transcript + inline coaching

Right: Generated rules + readiness + retest

```



\### 6.2 Live rehearsal



Should include:



\* AI rep avatar/video placeholder

\* AI rep opening pitch

\* provider-question input

\* suggested safe questions

\* restart rehearsal

\* retest with active rules



Suggested provider prompts must not encourage off-label questions. Safe prompts:



```text

Dosing

Safety information

Administration

Clinical trial data

Access / coverage

Request human follow-up

```



Off-label test path can exist as typed input or hidden demo scenario, but do not expose “Off-label use” as a suggested HCP-facing chip.



\### 6.3 Transcript coaching



Brand user can:



\* click a transcript line

\* comment on a line

\* highlight a phrase

\* say “say this more briefly”

\* say “mention titration earlier”

\* say “do not talk about Drug X”

\* say “always offer MSL for deep medical questions”



\### 6.4 Rule generation from feedback



System converts coaching into draft rules.



Rule examples:



```text

Feedback: “Say this more briefly.”

Rule: Persona style rule — keep responses under 45 seconds unless the HCP asks for detail.

Scope: Persona

Status: Draft

```



```text

Feedback: “Do not talk about Drug X.”

Rule: Blocked topic rule — do not mention Drug X unless an approved response exists.

Scope: Campaign or persona

Status: Needs review

```



```text

Feedback: “Mention titration earlier.”

Rule: Conversation ordering rule — present titration earlier in dosing responses using approved dosing content.

Scope: Campaign/topic

Status: Needs source validation

```



```text

Feedback: “Say our drug is safer than competitor X.”

System response: This requires an approved comparative claim. No active approved source was found, so this cannot be added as a live rule.

```



\### 6.5 Rule scopes



Every generated rule must have scope:



```text

Global

Campaign

Persona

HCP segment

HCP-specific

```



\### 6.6 Rule statuses



```text

Active

Draft

Needs source

Needs MLR

Rejected

Blocked by compliance

```



\### 6.7 Compliance gating



Training feedback must never bypass compliance.



A rule that changes medical, dosing, efficacy, safety, comparative, or promotional content must require source validation and MLR status before it becomes active.



\---



\## 7. AI Rep Studio: Audience mode



Audience must not be hidden. It is part of the rep lifecycle.



Audience mode should answer:



```text

Who will this AI rep talk to?

Why these HCPs?

What should the rep open with?

Are they ready to activate?

```



Data shown:



\* HCP

\* specialty

\* decile

\* opportunity score

\* whitespace segment

\* recommended approved topic

\* activation status

\* HCP-specific pointers if any



The system uses DocNexus claims-derived HCP-level aggregate features. Do not expose raw patient-level claims.



Preferred wording:



```text

Eligible patient opportunity

Claims-derived aggregate

No PHI

```



Avoid wording that implies patient-level surveillance.



\---



\## 8. AI Rep Studio: Launch mode



Launch should be visible but not CRM-heavy.



Launch mode should show:



\* readiness score

\* unresolved blockers

\* approved knowledge status

\* persona status

\* training/rehearsal status

\* audience readiness

\* escalation setup

\* CRM/follow-up automation status

\* launch channel

\* schedule

\* launch button



CRM should be automated in backend. Do not create a large “CRM Export” product tab.



After session completion, backend should create follow-up and CRM-compatible events automatically.



Brand user should see only:



```text

Follow-up created

Sent to CRM

Failed

Needs mapping

Retrying

Suppressed

```



JSON payloads should be hidden under “technical details” only.



\---



\## 9. AI Rep Studio: Improve mode



Improve mode is where the product becomes a learning AI rep platform.



It should support training from real sessions.



Sources:



```text

Rehearsal transcript

Real HCP session transcript

Real HCP session recording

Brand/compliance review comments

```



Actions:



```text

Select session

Review transcript

Review recording

Comment on transcript line

Create coaching note

Generate rule

Choose rule scope

Retest rep

Approve/reject/send for review

```



Examples:



```text

Feedback from session:

“Mention adherence support earlier when Dr. Sharma asks about adherence.”



Generated:

Type: HCP-specific pointer

Applies to: Dr. A. Sharma

Topic: adherence

Instruction: Mention adherence support earlier when adherence concerns arise.

Status: Needs source validation

```



```text

Feedback:

“Keep answers shorter.”



Generated:

Type: Persona style rule

Applies to: CardioNova AI Specialist

Instruction: Keep responses under 45 seconds unless HCP asks for detail.

Status: Draft

```



```text

Feedback:

“Never mention competitor X without approved source.”



Generated:

Type: Global/campaign comparative rule

Instruction: Comparative claims require active approved source.

Status: Active if already compliance-approved, otherwise needs review.

```



\---



\## 10. Sessions



Sessions should remain simple and useful.



Sessions answer:



```text

Who engaged?

What happened?

Which sessions need review?

What can we learn?

```



Session table should include:



\* HCP

\* date/time

\* duration

\* number of questions

\* compliance status

\* follow-up type

\* review action

\* train-from-session action



Compliance statuses:



```text

Approved

Needs review

AE routed

Blocked + escalated

```



Do not use vague “Clean.”



Session review should show:



\* transcript

\* recording placeholder

\* content shown

\* approved source IDs

\* MLR IDs

\* ISI delivery

\* off-label refusals

\* AE flags

\* follow-up created

\* audit package

\* coach rep from this session



Audit should be inside session review, not a primary top-level product.



\---



\## 11. Analytics



Analytics should stay.



Tabs:



```text

Targeting

Engagement

Content

Compliance

CRM/Ops

Realtime quality

ROI

```



Metrics required:



\### Targeting



\* high-opportunity HCPs

\* opportunity score

\* whitespace segment

\* decile

\* eligible patient opportunity

\* growth trend

\* recommended approved topic



\### Engagement



\* outreach sent

\* invite open rate

\* session start rate

\* session completion rate

\* average duration

\* repeat engagement

\* doctor usefulness rating

\* drop-off point



\### Content



\* topics discussed

\* content shown

\* approved answer usage

\* content gaps

\* content expiring soon



\### Compliance



\* ISI delivery rate

\* off-label refusals

\* AE captures

\* unapproved response count

\* sessions fully auditable

\* rules blocked by compliance



\### Follow-up / CRM ops



\* follow-up requests

\* follow-up completion rate

\* average time to follow-up

\* MSL SLA

\* AE/PV routing SLA

\* CRM export success

\* failed/retrying/needs mapping



\### Realtime quality



\* perceived latency

\* time to first audio

\* ASR latency

\* tool-call latency

\* retrieval latency

\* validation latency

\* TTS/avatar start latency

\* interruption recovery

\* fallback rate



Metrics should be clickable/drillable.



\---



\## 12. Follow-ups



Follow-ups should be lightweight.



Show:



\* HCP

\* follow-up type

\* owner

\* status

\* due date/SLA

\* source session

\* CRM status

\* retry/needs mapping if relevant



Status:



```text

Created

Sent to CRM

Failed

Needs mapping

Retrying

Completed

Suppressed

```



Do not make the user manually operate CRM unless there is an exception.



\---



\## 13. Doctor / HCP view



Doctor view must be simple and separate from brand UI.



Doctor must not see:



\* sidebar

\* Platform Admin

\* demo toggle

\* MLR IDs

\* CRM

\* runtime/compliance gate language

\* agent graph

\* JSON

\* internal rules



Doctor should see:



\* brand/session name

\* AI Representative — not a person

\* approved information only

\* avatar/video area

\* captions/transcript

\* detail aid

\* Important Safety Information

\* ask a question

\* request human representative

\* request medical information / MSL

\* report side effect

\* end session



Doctor-facing language should be simple:



```text

Checking approved information…

This question requires medical follow-up.

A representative can contact you.

Report side effect.

View full prescribing information.

```



No internal terminology.



\---



\## 14. Backend architecture



The first implementation may be a modular monolith, but it must have clean service boundaries.



Recommended structure:



```text

src/

&#x20; app/

&#x20; modules/

&#x20;   auth/

&#x20;   tenants/

&#x20;   aiRepStudio/

&#x20;   setupAssistant/

&#x20;   content/

&#x20;   mlr/

&#x20;   audience/

&#x20;   targeting/

&#x20;   sessions/

&#x20;   training/

&#x20;   rules/

&#x20;   retrieval/

&#x20;   compliance/

&#x20;   realtime/

&#x20;   vendors/

&#x20;   audit/

&#x20;   analytics/

&#x20;   followups/

&#x20;   crm/

&#x20; lib/

&#x20; tests/

&#x20; e2e/

&#x20; docs/

```



Core services:



```text

Input Adapter Layer

Canonical Data Layer

Content and MLR Service

Claims Targeting Service

Retrieval Service

Conversation Orchestrator

Risk Classifier and Policy Router

Response Builder and Validator

Compliance Gate

Training Rule Generator

Session Review Service

Escalation and Follow-Up Service

Audit Service

CRM Event Service

Analytics Service

Vendor Adapter Layer

```



\---



\## 15. Storage architecture



Use a hybrid storage model.



MVP:



```text

PostgreSQL

pgvector or equivalent vector index

Object storage or local storage abstraction

Append-only audit/event table

CRM outbox table

```



Future:



```text

Dedicated vector DB

Knowledge graph

Event bus

Warehouse/lakehouse analytics

Live CRM adapters

```



Rules:



```text

Postgres governs canonical truth.

Vector index retrieves candidates.

Object storage stores files/media.

Audit log proves what happened.

CRM outbox handles reliable async CRM export.

```



Do not make the vector DB the source of truth.



\---



\## 16. Canonical objects



Implement or mock these canonical objects:



```text

Tenant

Brand

Campaign

AIRep

AIRepPersona

SetupAssistantSession

SetupDraft

ApprovedContentSet

ContentAsset

ApprovedAnswer

ApprovedClaim

SafetyStatement

DetailAidSlide

MLRApproval

HCPProfile

HCPOpportunityScore

TargetList

PersonalizationBrief

ConversationSession

ConversationTurn

TrainingSession

TrainingComment

TrainingRule

HCPPointer

IntentRiskClassification

RetrievalEvent

SourceValidation

ResponseValidation

ComplianceDecision

ResponseOutput

EscalationEvent

FollowUpTask

CRMEvent

AuditRecord

```



Use canonical IDs everywhere:



```text

tenant\_id

brand\_id

campaign\_id

ai\_rep\_id

content\_asset\_id

approved\_answer\_id

hcp\_id

session\_id

turn\_id

rule\_id

crm\_event\_id

audit\_event\_id

```



\---



\## 17. Controlled retrieval



Retrieval flow:



```text

Question/input

→ metadata-filtered vector search over approved embeddings

→ candidate approved\_answer\_id / slide\_id / safety\_statement\_id

→ Postgres source validation

→ approved-block response construction

→ response validation

→ final compliance gate

→ output

```



Retrieval must only use:



```text

ACTIVE + APPROVED + NOT\_EXPIRED

```



Content must include:



\* MLR ID

\* version

\* source file

\* audience

\* indication

\* market

\* expiry

\* campaign

\* status



\---



\## 18. Controlled agent graph



HCP runtime graph:



```text

HCP input

→ realtime/ASR input adapter

→ combined intent/risk classifier

→ policy router

→ approved retrieval path / refusal path / AE path / MSL path / fallback path

→ retrieval and source validation

→ response builder

→ response validator

→ final compliance gate

→ avatar/TTS/detail aid output

→ audit + metrics + follow-up/CRM event

```



Logical judges must not necessarily become separate LLM calls.



Latency-aware design:



```text

Combine intent/off-label/AE/medical-info/prompt-injection detection where possible.

Run retrieval and risk classification in parallel when safe.

Use deterministic validation for MLR status, expiry, audience, campaign, exact ISI, source IDs.

Move deep QA, long summaries, content-gap clustering, and analytics aggregation async.

Fail safe if speed conflicts with compliance.

```



\---



\## 19. Realtime / interaction model architecture



Before implementation, create an evaluation spike comparing:



```text

Tavus CVI

GPT Realtime

Thinking Machines interaction-model direction if usable runtime/API exists

Fallback: Whisper + LLM + ElevenLabs/Mascot or text-only

```



Important distinction:



```text

Tinker SDK itself is mainly a model training/fine-tuning/post-training API.

Thinking Machines interaction models are conceptually relevant for realtime multimodal collaboration.

Do not assume Tinker is the production realtime runtime unless a usable interaction runtime/API is available.

```



Build the realtime layer behind adapters.



Interfaces:



```ts

interface RealtimeProvider {

&#x20; startSession(config): Promise<RealtimeSession>

&#x20; sendSystemEvent(event): Promise<void>

&#x20; sendToolResult(result): Promise<void>

&#x20; endSession(): Promise<void>

}



interface VoiceProvider {

&#x20; transcribe(audio): Promise<Transcript>

&#x20; synthesize(text, voiceConfig): Promise<AudioStream>

}



interface AvatarProvider {

&#x20; startAvatar(config): Promise<void>

&#x20; speak(textOrAudio): Promise<void>

&#x20; showDetailAid(slideId): Promise<void>

&#x20; endAvatar(): Promise<void>

}

```



No vendor-specific object should leak into core services.



Realtime model improves conversational fluidity; it does not replace compliance, retrieval, validation, audit, or CRM logic.



\---



\## 20. Vendor evaluation criteria



Create `docs/VENDOR\_EVAL.md`.



Compare:



```text

Tavus

GPT Realtime

Thinking Machines interaction models / Tinker distinction

Whisper + ElevenLabs + Mascot fallback

Text-only fallback

```



Evaluate:



\* latency

\* interruption/barge-in support

\* WebRTC/browser support

\* tool calling

\* custom backend tools

\* avatar/video support

\* audio quality

\* transcript access

\* auditability

\* data retention controls

\* PHI/BAA posture if relevant

\* vendor lock-in

\* cost

\* maturity

\* ease of local/dev mocking

\* ability to swap later



Decision rule:



```text

Pick one provider for the A/V spike.

Keep adapter interfaces so the provider can be swapped later.

```



\---



\## 21. Implementation stages



Use staged implementation. Do not try to build everything at once.



\### Stage 1: Onboarding + landscape



Goal:

Understand vendors and architecture.



Deliverables:



\* `docs/VENDOR\_EVAL.md`

\* teardown of Tavus / HeyGen / Synthesia / Doceree / Veeva

\* realtime vendor recommendation

\* A/V provider chosen for spike

\* adapter interfaces drafted

\* environment setup



\### Stage 2: A/V spike



Goal:

End-to-end talking twin proof.



Deliverables:



\* fixed script spoken by avatar/voice provider

\* browser UI

\* mocked transcript

\* fixed detail aid display

\* no real compliance yet

\* provider adapter boundary



Acceptance:

A demo can start a session, speak a fixed approved script, and end.



\### Stages 3–4: Conversation engine + RAG



Goal:

Approved-content library and retrieval-only answering.



Deliverables:



\* content ingestion for PPT/PDF/script/ISI/FAQ

\* canonical content objects

\* approved answer blocks

\* vector index or mocked retrieval if needed

\* source validation

\* response builder using approved blocks only

\* detail-aid tool call



Acceptance:

The AI rep answers only from approved blocks and can show a detail aid.



\### Stage 5: Compliance guardrails



Goal:

Safe pharma conversation paths.



Deliverables:



\* combined intent/risk classifier

\* off-label refusal

\* verbatim ISI dual-modality

\* AE capture and routing stub

\* MSL/medical information escalation

\* response validator

\* final compliance gate

\* audit log



Acceptance:

Off-label questions are refused, AE mentions are routed, ISI is delivered when required, and every turn has an audit record.



\### Stage 6: Twin Studio + MLR gating



Goal:

AI Rep Studio MVP.



Deliverables:



\* Build mode with DocNexus Setup Assistant

\* structured setup draft

\* persona creation

\* approved content binding

\* MLR sign-off/status model

\* Training/Preview rehearsal

\* coaching comments

\* generated draft rules

\* readiness score



Acceptance:

A brand user can configure, train, retest, and submit a rep for approval.



\### Stages 7–8: Whitespace targeting



Goal:

DocNexus targeting proof.



Deliverables:



\* HCP target list import

\* opportunity score

\* decile/segment

\* whitespace category

\* recommended approved topic

\* personalization brief

\* Audience mode



Acceptance:

A brand user can select high-opportunity HCPs and understand why each was chosen.



\### Stage 8: Escalation + handoff



Goal:

Automated follow-up.



Deliverables:



\* MSL routing

\* medical information routing

\* pharmacovigilance routing stub

\* human rep handoff

\* follow-up task creation

\* CRM outbox



Acceptance:

Follow-ups are created automatically from sessions and tracked without making CRM the center of the UI.



\### Stage 9: Analytics console



Goal:

Measure reach, engagement, content, compliance, and ops.



Deliverables:



\* Overview monitoring

\* sessions table

\* analytics tabs

\* content gap metrics

\* compliance metrics

\* follow-up metrics

\* realtime latency metrics



Acceptance:

Metrics are populated from session/audit/follow-up events.



\### Stage 10: Integration + hardening



Goal:

Demo-ready product.



Deliverables:



\* channel embed/web session

\* CRM-compatible logging

\* latency/quality pass

\* adapter mocks

\* error states

\* environment variables

\* deployment docs

\* Playwright E2E and visual tests



Acceptance:

The full flow works reliably end-to-end.



\### Stage 10: Demo + handover



Goal:

Final readout and handover.



Deliverables:



\* walkthrough file

\* demo script

\* testing instructions

\* architecture notes

\* compliance self-audit

\* final readout to Mahek + team



\---



\## 22. Testing plan



Testing is mandatory.



\### 22.1 Unit tests



Cover:



\* adapters

\* normalizers

\* content versioning

\* MLR status checks

\* retrieval filters

\* response validation

\* compliance gate

\* CRM outbox

\* rule generation

\* rule scoping

\* setup assistant field inference



\### 22.2 Integration tests



Cover:



```text

content upload → canonical content → approved answer retrieval

setup assistant → setup draft fields filled

training comment → draft rule generated

session transcript → HCP-specific pointer generated

HCP question → retrieval → compliance gate → output

off-label question → refusal → MSL escalation

AE mention → AE capture → PV escalation

session end → follow-up task → CRM outbox

```



\### 22.3 Playwright E2E tests



Create `e2e/nexusrep.spec.ts`.



Test full flows:



\#### Flow 1: Build setup



```text

Open AI Rep Studio

DocNexus Setup Assistant asks setup question

Select/answer brand

Structured setup draft updates

Upload/choose approved content

Persona display name fills correctly

Voice/disclosure/greeting fields fill correctly

Readiness changes

No \[object Object] appears

```



\#### Flow 2: Training preview



```text

Open Train mode

Start rehearsal

AI rep pitch appears

Brand user asks provider question

Transcript updates

User comments on transcript line

Draft rule appears

Rule scope can be changed

Rule can be accepted

Retest button works

```



\#### Flow 3: Train from session



```text

Open Sessions

Select session

Open transcript/recording review

Click Train from this session

Comment on transcript line

Generate rule

Choose HCP-specific pointer

Save draft

Verify Improve/Rules shows the rule

```



\#### Flow 4: Compliance



```text

Ask in-label question

Approved response appears with source

Ask off-label question

Response is refused

MSL escalation created

Ask AE-like question

AE routing appears

Audit record exists

```



\#### Flow 5: Audience and launch



```text

Open Audience

Select HCP

HCP appears in activation list

Open Launch

Resolve readiness blockers

Launch button becomes enabled

Launch creates invite/status

```



\#### Flow 6: Follow-ups



```text

End session with human/MSL request

Follow-up appears

CRM status is Created/Sent/Needs mapping

Retry action works for failed item

```



\### 22.4 Visual regression tests



Use Playwright screenshots.



Create baseline screenshots for:



\* AI Rep Build

\* AI Rep Train

\* Audience

\* Launch

\* Sessions

\* Session Review / Train from session

\* Analytics

\* Follow-ups

\* HCP invite

\* HCP conversation



Visual checks must catch:



\* header clipping

\* hidden tabs under sticky header

\* overlapping floating controls

\* `\[object Object]`

\* cramped tables

\* broken wrapping

\* empty dead space

\* decision path clipping

\* doctor view showing internal terms



\### 22.5 Accessibility and UX checks



Basic checks:



\* all primary buttons have labels

\* forms are reachable by keyboard

\* text inputs have labels

\* contrast acceptable

\* HCP flow has simple language

\* doctor view does not expose internal platform terms



\---



\## 23. Walkthrough and documentation requirement



Claude Code must maintain a file:



```text

docs/WALKTHROUGH.md

```



Update it after every meaningful implementation step.



It must include:



```text

What changed

Files added/edited

How to run locally

How to test

How to run Playwright tests

How to demo the flow

Known limitations

Next steps

```



Suggested structure:



```md

\# NexusRep Walkthrough



\## Current build status



\## How to run



\## Demo script



\### Demo 1: Build AI Rep

\### Demo 2: Train AI Rep

\### Demo 3: Train from session

\### Demo 4: Audience and launch

\### Demo 5: HCP conversation

\### Demo 6: Sessions / analytics / follow-ups



\## Test commands



\## Playwright visual tests



\## Implementation log



\### YYYY-MM-DD

\- Added:

\- Changed:

\- Verified:

\- Known issues:

```



\---



\## 24. Claude Code project instructions



Create or update root `CLAUDE.md`.



Recommended contents:



```md

\# Claude Code Instructions for NexusRep



You are implementing NexusRep, an AI-first pharma AI Rep Studio.



Do not turn the product into a generic CRM, campaign manager, or dashboard.



Core product loop:

Build the rep → Train the rep → Choose audience → Launch → Improve from sessions.



Two AI roles:

1\. DocNexus Setup Assistant: internal setup assistant for brand users.

2\. HCP-facing AI Rep: outward-facing compliant digital rep.



Hard rules:

\- Approved content only.

\- No generated medical/promotional claims.

\- Off-label questions must be refused and routed.

\- AE mentions must route to pharmacovigilance.

\- ISI must be delivered verbatim when required.

\- Raw patient-level claims must not enter live conversation context.

\- CRM is automated backend handoff, not the main product UI.

\- Every response must pass final compliance gate before output.



Architecture:

\- Modular monolith first, service boundaries clear.

\- All sources/vendors through adapters.

\- Postgres as canonical truth.

\- Vector retrieval only returns candidate IDs.

\- Source validation and compliance gate decide eligibility.

\- Vendor/realtime provider must be swappable.



Testing:

\- Add unit tests for core logic.

\- Add Playwright E2E and visual tests.

\- Maintain docs/WALKTHROUGH.md after every implementation step.

```



\---



\## 25. Claude Code skills recommendation



Use a small number of local project skills only if supported in the environment.



Recommended skills:



\### Skill 1: nexusrep-product-context



Purpose:

Keep Claude aligned on product direction.



Use when:

Making UI/UX, product flow, naming, or feature decisions.



Include:



\* AI-first product framing

\* two AI roles

\* core flow

\* compliance non-negotiables

\* what not to build



\### Skill 2: nexusrep-compliance-architecture



Purpose:

Keep retrieval, validation, audit, and CRM safe.



Use when:

Changing conversation, retrieval, rules, content, compliance, audit, or CRM logic.



Include:



\* approved-content-only response

\* compliance gate

\* risk classifier

\* source validation

\* audit record

\* CRM outbox

\* PHI minimization



\### Skill 3: nexusrep-playwright-qa



Purpose:

Guide E2E and visual testing.



Use when:

Adding or updating tests.



Include:



\* required flows

\* visual regression targets

\* no `\[object Object]`

\* no overlapping controls

\* doctor view should not show internal terms



Do not create too many skills. Too many skills will waste attention and increase inconsistency.



\---



\## 26. Optional Claude Code subagents



If using Claude Code subagents, create only these:



\### frontend-reviewer



Role:

Review visual hierarchy, spacing, terminology, hidden states, and role realism.



Checks:



\* brand user clarity

\* doctor user clarity

\* no CRM/campaign-manager drift

\* no internal jargon in HCP view

\* no clutter/overlap



\### qa-engineer



Role:

Write and maintain Playwright tests and visual regression.



Checks:



\* full flow works

\* fields fill correctly

\* training rules are generated

\* session-to-training loop works

\* compliance paths work



\### architecture-guardian



Role:

Prevent vendor lock-in and unsafe coupling.



Checks:



\* adapter boundaries

\* no vendor objects in core services

\* no raw patient claims in runtime

\* Postgres source of truth

\* vector index not source of truth



\---



\## 27. Acceptance criteria for current implementation push



The next implementation push is accepted only if:



1\. AI Rep Studio is first-class and clearly AI-first.

2\. Build mode has DocNexus Setup Assistant and structured inferred setup.

3\. Setup fields are not removed; they are inferred and editable.

4\. Train mode supports rehearsal coaching.

5\. Sessions support “train from this session.”

6\. Rules support global, campaign, persona, HCP-segment, and HCP-specific scopes.

7\. Audience and Launch are visible in the AI Rep lifecycle.

8\. CRM is automated into Follow-ups and backend events, not a major manual tab.

9\. Doctor view has no internal jargon.

10\. Playwright E2E covers build, train, session training, compliance, audience, launch, and follow-ups.

11\. Playwright visual tests cover major screens.

12\. `docs/WALKTHROUGH.md` is updated with how to run, test, and demo.



\---



\## 28. Immediate implementation order



Start with:



1\. Create/update `CLAUDE.md`.

2\. Create `docs/WALKTHROUGH.md`.

3\. Create `docs/VENDOR\_EVAL.md`.

4\. Refactor navigation and AI Rep lifecycle tabs.

5\. Implement Build mode with DocNexus Setup Assistant + structured setup draft.

6\. Implement Train mode with transcript comments + draft rule generation.

7\. Implement Rules model with scope and status.

8\. Add “Train from this session” from Sessions.

9\. Add Audience and Launch as visible AI Rep lifecycle steps.

10\. Add Playwright E2E + visual tests.

11\. Update walkthrough after every step.



Do not add new dashboards before these are done.



