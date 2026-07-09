# NexusRep — Vendor & Realtime Interaction-Model Evaluation

_Stage 1 deliverable (brief §19–20). Goal: pick **one** provider for the A/V spike while keeping
adapter interfaces so the provider can be swapped later. This document is a landscape teardown and
a recommendation — not a procurement decision._

> **Architecture rule that frames everything below:** the realtime layer improves conversational
> fluidity. It does **not** replace compliance, retrieval, validation, audit, or CRM logic. No
> vendor-specific object may leak into core services — everything passes through the
> `RealtimeProvider` / `VoiceProvider` / `AvatarProvider` / `CrmAdapter` / `RetrievalProvider`
> interfaces defined in `src/modules/vendors` and `src/modules/realtime`.

---

## 1. The Tavus / GPT Realtime / Thinking Machines distinction

A recurring confusion worth stating plainly before the comparison:

| Thing | What it actually is | Role in NexusRep |
| --- | --- | --- |
| **Tavus CVI** | Conversational Video Interface — hosted pipeline (avatar video + ASR + turn-taking + tool calls) over WebRTC. | Candidate **realtime + avatar** provider for the spike. |
| **GPT Realtime** | Low-latency speech-to-speech model API with tool calling. No avatar video; pair with an avatar renderer. | Candidate **realtime/voice** provider; strong tool-calling fit. |
| **Thinking Machines — interaction models** | Conceptual direction for realtime multimodal collaboration. Relevant *concept*, but confirm a usable realtime runtime/API exists before depending on it. | Watch-list. Not the spike. |
| **Tinker SDK** | A model **training / fine-tuning / post-training** API. **Not** a production realtime runtime. | Out of scope for realtime. Possible future for custom classifiers, **not** the live A/V path. |

**Do not assume Tinker is the production realtime runtime.** Treat Thinking Machines' interaction
models as conceptually interesting but unproven for our live loop until a real runtime/API is in hand.

---

## 2. Provider teardown

### 2.1 Realtime / avatar / voice candidates

| Provider | What it gives us | Strengths | Risks / gaps for pharma |
| --- | --- | --- | --- |
| **Tavus (CVI)** | Hosted avatar video + conversational pipeline, WebRTC, tool calls, transcripts. | Fastest path to a "talking twin"; avatar + transport + turn-taking in one. | Pipeline owns more of the loop → must verify we can inject our compliance gate **before** TTS/avatar speaks; data-retention/BAA posture must be checked; vendor lock-in if we lean on its orchestration. |
| **GPT Realtime** | Speech-to-speech + robust tool calling. | Excellent low latency + barge-in; tool calling maps cleanly to our retrieval/escalation tools; mature SDKs. | No avatar (pair with renderer); data-handling/BAA posture for pharma; we must still gate output. |
| **Whisper + ElevenLabs + Mascot/text (fallback)** | Compose ASR (Whisper) + TTS (ElevenLabs) + simple avatar/mascot or text. | Maximum control; each piece swappable; easiest to mock locally; cheapest to start; keeps compliance gate squarely in our code. | We own turn-taking/barge-in (harder); more glue; higher perceived latency without careful streaming. |
| **Text-only fallback** | No A/V at all. | Always works; trivial to test; zero vendor dependency; great for E2E/CI. | Not the demo experience; no voice/avatar fluidity. |

### 2.2 Market reference teardown (what the incumbents already do)

| Product | What it is | What NexusRep does differently |
| --- | --- | --- |
| **Tavus** | A/V conversational interface vendor. | We treat it as a replaceable A/V provider behind an adapter, not the product. |
| **HeyGen** | Avatar video generation / streaming avatars. | Candidate avatar renderer behind `AvatarProvider`; not an orchestration layer. |
| **Synthesia** | Scripted avatar **video generation** (not low-latency conversational). | Useful for pre-rendered detail-aid intros; **not** a live realtime loop. |
| **Doceree RepTwin** | Virtual pharma brand rep across video/voice/text/EHR/email, trained on MLR-approved content. | Closest analogue. We differentiate via **DocNexus claims-ranked targeting**, transparent **source validation**, full **auditability**, and **CRM-ready outcome events**. |
| **Veeva (Engage / Vault CRM / Approved Email)** | System of record for HCP engagement, approved content sharing, approved email. | We are **CRM-compatible**, not a CRM. We write AI-detail activity, content-shown, follow-up tasks, and compliance flags into CRM-compatible records via output adapters; Veeva is a destination, not the brain. |

---

## 3. Evaluation criteria (scored per the brief)

Scoring legend: 🟢 strong · 🟡 workable · 🔴 weak/unknown-needs-verification.

| Criterion | Tavus CVI | GPT Realtime | Whisper+ElevenLabs+Mascot | Text-only |
| --- | --- | --- | --- | --- |
| Latency / time-to-first-audio | 🟢 | 🟢 | 🟡 | 🟢 |
| Interruption / barge-in | 🟢 | 🟢 | 🔴 (we build it) | n/a |
| WebRTC / browser support | 🟢 | 🟢 | 🟡 | 🟢 |
| Tool calling (our retrieval/escalation tools) | 🟡 | 🟢 | 🟢 (we orchestrate) | 🟢 |
| Custom backend tools | 🟡 | 🟢 | 🟢 | 🟢 |
| Avatar / video | 🟢 | 🔴 (pair renderer) | 🟡 (mascot) | 🔴 |
| Audio quality | 🟢 | 🟢 | 🟢 | n/a |
| Transcript access | 🟢 | 🟢 | 🟢 | 🟢 |
| Auditability (we capture every turn) | 🟡 | 🟡 | 🟢 | 🟢 |
| Data-retention controls | 🔴 verify | 🔴 verify | 🟢 | 🟢 |
| PHI / BAA posture | 🔴 verify | 🔴 verify | 🟢 (self-hosted-able) | 🟢 |
| Vendor lock-in | 🔴 | 🟡 | 🟢 | 🟢 |
| Cost | 🟡 | 🟡 | 🟢 | 🟢 |
| Maturity | 🟢 | 🟢 | 🟢 | 🟢 |
| Ease of local/dev mocking | 🔴 | 🟡 | 🟢 | 🟢 |
| Ability to swap later (with our adapters) | 🟢 | 🟢 | 🟢 | 🟢 |

> The 🔴 "verify" cells (data retention, BAA/PHI) are **gating** for any production pharma use and
> must be confirmed contractually before a provider handles real HCP audio. For the MVP we keep raw
> patient-level data out of all third-party vendors regardless (see CLAUDE.md hard rules).

---

## 4. Recommendation

**Build order, not a single bet:**

1. **Default dev/CI provider: text-only + Whisper/ElevenLabs/Mascot mock.** It keeps the compliance
   gate entirely in our code, mocks cleanly, and lets every E2E/visual test run without network or
   keys. This is the provider our adapters target *first*.
2. **A/V spike provider: GPT Realtime** (paired with a simple avatar/mascot renderer behind
   `AvatarProvider`). Rationale: best-in-class latency + barge-in, the cleanest **tool-calling** fit
   for our retrieval/escalation tools, and it leaves orchestration (and therefore the compliance
   gate) in our control. Tavus remains the strong **alternative** if a one-box avatar+pipeline demo
   is prioritized over orchestration control — the adapter boundary means switching is a config change.
3. **Do not** depend on Tinker / Thinking Machines for the live loop until a usable realtime
   runtime/API is confirmed.

**Decision rule (per brief):** pick one provider for the A/V spike; keep adapter interfaces so the
provider can be swapped later. Chosen for spike → **GPT Realtime**; chosen for dev/CI → **mock/text-only**.

---

## 5. Adapter interfaces (the contract every provider implements)

These live in code (`src/modules/realtime` and `src/modules/vendors`). Restated here so the
evaluation and the implementation stay in sync:

```ts
interface RealtimeProvider {
  startSession(config: RealtimeSessionConfig): Promise<RealtimeSession>;
  sendSystemEvent(event: RealtimeSystemEvent): Promise<void>;
  sendToolResult(result: ToolResult): Promise<void>;
  endSession(): Promise<void>;
}

interface VoiceProvider {
  transcribe(audio: AudioInput): Promise<Transcript>;
  synthesize(text: string, voice: VoiceConfig): Promise<AudioStream>;
}

interface AvatarProvider {
  startAvatar(config: AvatarConfig): Promise<void>;
  speak(textOrAudio: SpeakInput): Promise<void>;
  showDetailAid(slideId: string): Promise<void>;
  endAvatar(): Promise<void>;
}
```

`CrmAdapter` (outbox-driven) and `RetrievalProvider` (returns candidate IDs only) follow the same
pattern. No vendor SDK type may appear outside its adapter implementation.

---

## 6. Open verification items before any production use

- [ ] Confirm Tavus/GPT-Realtime **data retention** controls and **BAA/PHI** posture in writing.
- [ ] Confirm we can inject the **final compliance gate before** the avatar/TTS speaks (no provider
      auto-speaks model output without our approval).
- [ ] Confirm transcript + tool-call events are exposed for **audit** capture on every turn.
- [ ] Latency budget test per provider: ASR → classifier+retrieval → validation → gate → TTS/avatar start.
- [ ] Vendor-swap test: same scripted conversation runs through mock, GPT Realtime, and Tavus
      without changing core behavior.
