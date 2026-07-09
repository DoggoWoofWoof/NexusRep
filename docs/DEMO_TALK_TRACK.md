# NexusRep Demo Talk Track

Use this when walking someone through the product. The central message is:

> NexusRep trains and launches a compliant AI rep for the right HCPs. Tavus renders the human video experience; NexusRep decides what can be said.

## 1. Start With The Product Loop

NexusRep is not a CRM dashboard or an avatar demo. The loop is:

1. Build the rep.
2. Train the rep.
3. Choose the audience.
4. Launch to HCPs.
5. Improve from recorded sessions.

The brand user uploads approved content, rehearses and coaches the rep, chooses the HCP cohort, launches the video rep, then reviews real conversations and follow-ups.

## 2. How Intent Classification Works

For every HCP turn, NexusRep runs one combined classifier. It returns:

- intent, such as `product_info`, `dosing`, `safety`, `trial_data`, `human_request`, `off_label`, or `adverse_event`
- risk scores for off-label, adverse event, medical-information, prompt-injection, and comparative-claim risk
- whether ISI is required

The default local classifier is deterministic keyword scoring so the demo works offline and is auditable. The same interface can be backed by Claude, OpenAI-compatible models, or another classifier provider. If classification is uncertain or risky, the router fails safe to refusal, Medical Information, pharmacovigilance, human handoff, or fallback.

Example:

- "What is Milvexian?" -> `product_info` -> retrieve approved content -> answer + exact ISI
- "What dose should I use?" -> `dosing` -> investigational guardrail -> Medical Information
- "Can I use it in pediatrics?" -> `off_label` -> refuse + MSL follow-up
- "My patient had serious bleeding" -> `adverse_event` -> PV follow-up

## 3. How Approved Content And Slides Become The Knowledge Base

Uploaded PPTX/PDF/TXT content is parsed into canonical internal objects:

- `ContentAsset`: the source file and MLR metadata
- `ApprovedAnswer`: a retrievable speakable block
- `DetailAidSlide`: the slide the rep can show while speaking
- `SafetyStatement`: exact ISI text

PPTX is extracted slide-by-slide, and PDF is extracted page-by-page. Parsed content starts as `in_mlr`, so it cannot be spoken until MLR approves the source document. In the UI, source files appear in the Source library, while Live rep knowledge shows retrievable passages derived from active documents. NexusRep stores the document, the ordered passages, the linked detail-aid slides, and the safety statements as its own first-party knowledge base. Retrieval only returns candidate IDs. The source validator then checks MLR status, expiry, audience, indication, market, and campaign before a response can use that content.

The rep can reword the approved answer body when an LLM composer is configured, but it cannot invent claims. ISI is appended exactly when required and the final gate checks the exact ISI text before output.

If the brand wants different ISI wording, do not coach it in the live answer. In Build -> Approved knowledge, edit the ISI as a proposed safety block, submit it for MLR review, then approve it. After approval, the new block becomes the exact ISI the agent uses live and the previous active block is retired.

The deck walkthrough is also first-party. In the HCP preview, "Walk through deck" and "Next slide" call NexusRep's presentation skill, which selects the next retrievable passage from the active approved document by slide order, speaks the approved text, appends exact ISI, logs the turn, and moves the approved deck. Tavus can render the avatar for that output, but it does not own the deck logic.

## 4. How Coaching Changes The Rep

Training is an iterative loop:

1. Ask the rep a rehearsal question.
2. Coach the answer in plain language.
3. The rep re-answers using the coaching.
4. Keep coaching until the answer is right.
5. Accept the answer.

Style and emphasis coaching becomes reviewable rules. Compliance-sensitive coaching, like "do not discuss X" or comparative-claim instructions, stays as its own gated rule. Accepted style rules feed the live composer as guidance, but they never override approved content, ISI, routing, or the final compliance gate.

For the demo phrasing: "I can make the answer warmer or shorter here. If we want to change the ISI itself, that is a content approval step, so we edit and approve the safety block in Approved knowledge."

The opening greeting is coachable too, but it must retain the required AI disclosure, investigational status, and Medical Information routing.

## 5. How Audience Scoring Works

The demo audience uses HCP-level aggregate cohort features only, never patient-level data:

- eligible-patient density for the target indications
- current brand-share / whitespace signal
- quarter-over-quarter trend
- rep coverage / no-see signal
- specialty and decile

The opportunity score is deterministic:

- whitespace: 45%
- eligible-patient density: 35%
- trend: 20%

Scores are cohort-relative for the demo, so the highest-density HCP in the cohort defines the density reference. The score is a rankable opportunity signal, not an LLM guess.

## 6. How Launch And Doctor Outreach Works

In the demo, the HCP experience lives at `/hcp`. In production, Launch would create a secure HCP invitation link for each approved target, such as:

```text
https://your-nexusrep-domain.com/hcp?invite=<signed-token>
```

That token would map to the brand, campaign, HCP, allowed content scope, expiry, and audit context. Outreach can happen through the brand's approved channels:

- CRM task or email from Veeva/Salesforce
- rep-triggered follow-up
- approved HCP portal link
- scheduled Tavus/meeting invite where appropriate

NexusRep records the session, audit trail, routing decisions, and follow-ups. CRM is the backend handoff, not a manual tab the rep uses during the conversation.

## 7. What Tavus Does Versus What NexusRep Does

Tavus provides the real-time video PAL/Face experience: WebRTC room, face, voice, STT/TTS, recording callback, utterance events, and optional Knowledge Base / presentation skills.

NexusRep remains the compliance brain:

- classifies intent/risk
- retrieves approved source IDs
- validates MLR/audience/market/expiry
- composes from approved blocks
- appends exact ISI when required
- runs the final compliance gate
- creates audit records and follow-ups

Useful Tavus enhancements to consider next:

- optionally mirror approved decks/PDFs into Tavus Knowledge Base for renderer-side context, while keeping NexusRep KB/RAG as the source of truth
- optionally attach Tavus `presentation` skill as a rendering convenience, while keeping NexusRep's presentation skill authoritative
- use Tavus guardrails for extra runtime alerts, while keeping NexusRep routing as the authoritative gate
- add a Hair Check / pre-call screen to hide cold-start and join latency
- use pronunciation dictionaries and hotwords for terms like Milvexian, LIBREXIA, Factor XIa, and apixaban

## 8. How To Demo The Real Session Review

Open Sessions and click the video-backed Tavus session:

- `session_mrchcarx3f9rsk`
- `01:46`
- `7` HCP questions
- `AE routed`
- `4 follow-ups`
- recording: `/recordings/nexusrep-real-tavus-session-20260709.webm`

Explain that "Gate cleared 7/7" means every final output passed the final gate. It does not mean seven sourced product answers were approved. In that session, two turns used approved source content and slides; the other turns were safe routed outcomes.

The replay shows:

- the recorded Tavus AI rep video
- the transcript
- the approved slide being discussed
- turn-level evidence and audit records
