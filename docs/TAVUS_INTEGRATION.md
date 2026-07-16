# Tavus CVI integration — feature map

How every Tavus Conversational Video Interface (CVI) feature links to NexusRep, and
what activates when you set `TAVUS_API_KEY`. Contract sourced from `tavus.txt`
(docs.tavus.io bundled export): base `https://tavusapi.com/v2`, auth header
`x-api-key`.

Tavus's current docs use **PAL** for the behavior/knowledge/pipeline object and
**Face** for the visual likeness + voice. Their legacy `persona` / `replica`
endpoints and request fields still work, and the code keeps those adapter-local
names where Tavus still requires them. NexusRep public/domain language should say
**agent**, **PAL**, or **face**, not expose `replica` to users.

## The one rule that shapes everything

Tavus must **never generate an answer to an HCP** — that would bypass the compliance
gate. So Tavus is the **face + voice + ears + transport**, and **our orchestrator is the
brain**. We do this with Tavus's **custom-LLM layer**: the persona's `layers.llm.base_url`
points at our OpenAI-compatible endpoint, so Tavus sends each transcribed HCP turn to us,
we run classify → route → grounding → compliance gate, and the face speaks **only our
approved text**.

```
HCP speaks OR typed text is sent with conversation.respond
  → Tavus STT / PAL turn pipeline
  → POST /api/tavus/llm/chat/completions
  → our orchestrator (gate) → approved text (SSE) → Tavus TTS → face speaks it
```

## Feature-by-feature mapping

| Tavus feature | NexusRep mapping | Status |
|---|---|---|
| **PAL / Persona** `system_prompt`, `context`, `layers` | One stable NexusRep PAL reused and PATCHED in place by `TavusRealtimeProvider.ensurePersona` (or pin with `TAVUS_PERSONA_ID`) | ✅ wired |
| **Face / Replica** (video avatar) | `RealtimeSessionConfig.agentId` ← Studio Agent selection or `TAVUS_REPLICA_ID` fallback | ✅ wired |
| **Create Conversation** → `conversation_url` | `startSession()` → `RealtimeSession.transportUrl` (+ `token`) | ✅ wired |
| **Custom greeting** | Stored in `RealtimeSessionConfig.customGreeting`, then spoken client-side via normal `conversation.echo` after join so it is interruptible. We do **not** send Tavus `custom_greeting`, because Tavus treats the native greeting as non-interruptible. | ✅ wired |
| **Conversational context** | `config.context` → `conversational_context` (no PHI) | ✅ wired |
| **Custom LLM** (`layers.llm.base_url`) | → `POST /api/tavus/llm/chat/completions` = our compliance orchestrator, OpenAI-compatible SSE | ✅ wired + tested |
| **LLM speculative inference** | `layers.llm.speculative_inference = false` by default; opt in with `NEXUSREP_TAVUS_SPECULATIVE=1` only after validating it does not emit unstable partial answers | ✅ wired |
| **Conversational Flow** | `sparrow-1`, `turn_taking_patience: "low"`, `replica_interruptibility: "high"`, `voice_isolation: "near"` | ✅ wired for lower response latency |
| **Text Respond Interaction** | typed HCP text in video mode uses `conversation.respond`, so Tavus runs the same PAL/custom-LLM path as mic input | ✅ wired |
| **Echo / interrupt** (verbatim speech) | `conversation.echo` remains for platform-controlled scripted segments, e.g. guided overview. Typed/scripted barge-in sends `conversation.interrupt`; microphone speech-start does not, so Tavus can still finalize the HCP utterance. | ✅ wired client-side |
| **Tool / function calling** | `config.tools[{name,description,parameters}]` → legacy inline `layers.llm.tools`; routing also handled inside our LLM endpoint. For new external tools, prefer Tavus tool registry. | 🟡 legacy-compatible; registry not needed yet |
| **STT engine + hotwords** (drug names) | `NEXUSREP_TAVUS_STT` defaults to `tavus-deepgram-medical`; `config.hotwords` → `layers.stt.hotwords` with Milvexian/LIBREXIA/Factor XIa plus tested ASR mis-hears | ✅ wired |
| **TTS voice / speech latency** | `layers.tts` is pinned to Cartesia `sonic-3` with global speed from `NEXUSREP_TAVUS_TTS_SPEED`; `config.voice.voiceId` still maps to `external_voice_id` when present | ✅ wired |
| **Language / multilingual** | `config.language` → conversation `properties.language` | ✅ wired |
| **Audio-only mode** | `config.audioOnly` → `audio_only` | ✅ wired |
| **End conversation** | `endSession()` → `POST /conversations/{id}/end` | ✅ wired |
| **Transport (Daily/WebRTC)** | `transportUrl` is a Daily room; client joins with `@daily-co/daily-js` | ✅ wired |
| **Utterance / started-speaking events** | Received client-side over the Daily data channel; our captions/slides are driven from the audited NexusRep session and remote audio timing | ✅ wired |
| **Perception (Raven vision)** | Persona `layers.perception` — available, not needed for the HCP rep | ⚪ optional |
| **Guardrails / objectives / memory / documents** | Persona/PAL-level — our compliance gate and first-party RAG are authoritative; Tavus docs/KB are not product truth | ⚪ optional |
| **Recording / transcription / callbacks** | `properties.enable_recording`, `callback_url`; `/api/tavus/webhook` handles `application.recording_ready`. Prefer `system.pal_joined` over legacy `system.replica_joined`. | ✅ wired |
| **Avatar as a separate provider** | Not needed — in Tavus mode the face is the realtime video surface | ✅ by design |

## Activate it

```
TAVUS_API_KEY=<key>
TAVUS_REPLICA_ID=<stock or custom replica id>
TAVUS_PERSONA_ID=p7dfc4ad195f                              # stable NexusRep PAL; patch in place
NEXUSREP_PUBLIC_URL=https://<publicly-reachable-app-url>   # so Tavus can call our LLM endpoint
TAVUS_LLM_KEY=<any shared secret>                          # optional, authenticates Tavus→us
NEXUSREP_TAVUS_TTS_ENGINE=cartesia                         # default
NEXUSREP_TAVUS_TTS_MODEL=sonic-3                           # default
NEXUSREP_TAVUS_TTS_SPEED=1.0                               # neutral default; clamped 0.8-1.2
```
With no key, `getRealtimeProvider()` returns the mock and the HCP view uses the built-in
free 3D avatar — the app never breaks.

Tavus video replies use the exact same answer-composition path as typed chat — there is no
separate Tavus compose toggle. When `NEXUSREP_COMPOSE` resolves to `llm` and a Claude/OpenAI
key is present, Tavus receives grounded LLM-rephrased answers; with no key it gets the
deterministic approved-block builder. Either way Tavus never composes its own answer: it always
relays what our `/api/tavus/llm` endpoint returns, after retrieval, validation, the final
compliance gate, ISI cadence, source IDs, slide IDs, audit, and follow-up creation have all run.

Persona reuse is intentionally single-PAL. Pin `TAVUS_PERSONA_ID` whenever possible so every
session updates the same Tavus PAL in place. If the env is missing, `TavusRealtimeProvider`
scores existing `NexusRep compliant rep*` PALs by current custom-LLM URL,
`nexusrep-compliance` model, `tavus-deepgram-medical`, hotwords, and Cartesia Sonic-3 before
reusing one. It PATCHES that PAL in place and only POSTs `/personas` when the account has no
NexusRep PAL at all. On 2026-07-15 the live Tavus account was cleaned down to one NexusRep PAL:
`p7dfc4ad195f` (`NexusRep compliant rep`).

## Verified against the live API (2026-07-08)

Validated with a real key + stock replica **Charlie** (`rf4703150052`):
- `GET /v2/replicas` → 200 (key valid).
- `POST /v2/personas` (our exact body: custom-LLM layer + STT hotwords) → 200.
- `POST /v2/conversations` → 200, returns a real Daily join URL; `POST /…/end` → 200.

Two things the docs don't spell out that the live API enforces (both fixed):
1. A custom LLM requires **both** `base_url` **and** `api_key` — we always send a non-empty
   `api_key` (defaults to the `TAVUS_LLM_KEY` shim).
2. You may **not** set `tts.external_voice_id` with the default STT engine — omit it and the
   face uses its own default voice.

## Latency policy

Tavus latency has three separate parts:

1. **Join/cold start**: the PAL/Face joins the Daily room. We reuse one PAL per brand,
   patch it when prompt/layers change, and explicitly end conversations on close to avoid
   concurrent-session buildup.
2. **Turn detection**: `layers.conversational_flow` uses `sparrow-1` with
   `turn_taking_patience: "low"` and `voice_isolation: "near"` so the PAL responds quickly
   after the HCP stops speaking while still filtering background noise.
3. **Speech synthesis/rendering**: `layers.tts` is explicitly pinned to Cartesia `sonic-3`
   with `NEXUSREP_TAVUS_TTS_SPEED` defaulting to neutral `1.0`, so existing cached PALs do
   not keep an older or unknown Tavus auto TTS choice. Override the env only if a specific
   voice needs a faster/slower delivery.
4. **Answer generation**: Tavus calls our custom LLM endpoint. The endpoint runs the same
   NexusRep composer policy as the rest of the live rep: grounded LLM rephrase when keyed,
   deterministic approved text only when no composer is available or when explicitly forced.
   If the composer errors or exceeds the hot-path timeout, the orchestrator falls back to
   approved deterministic text rather than keeping Tavus silent.

The custom-LLM endpoint does not hide latency by delaying transcript text. It emits
`Server-Timing` and `X-NexusRep-Timing` headers plus a `[tavus-llm-latency]` server log for
each call. The turn audit also records classification, retrieval, and composer latencies so
the Render/Tavus gap can be split into "NexusRep before text" versus "Tavus after text".

Typed video input uses Tavus `conversation.respond`, not the slower
browser-fetch-then-`conversation.echo` path. `conversation.echo` is reserved for exact
platform-controlled speech such as guided overview segments where NexusRep is deliberately
driving slide-by-slide narration.

`window.__nexusrepTiming` records client-side timing markers (`typed_respond_sent`,
`echo_queued`, `vendor_streaming_utterance`, `vendor_final_utterance`,
`vendor_started_speaking`, `vendor_audio_activity`, `caption_release`) for live Render/Tavus
latency debugging.

## Client join — built

`POST /api/realtime/conversation` (vendor-neutral) opens the conversation and returns
`{ provider, configured, conversationUrl, token, reachableLlm }`.
`src/app/_components/VideoAgentStage.tsx` is vendor-agnostic: it picks a client transport by the
returned `provider` name (`src/app/_components/video-transport.ts` — the ONLY client file that
knows Tavus's Daily/respond/echo/utterance protocol), renders the agent's video + audio, and is toggled
by the **"Video rep"** button on `/hcp`. With no key it reports `configured:false` and the view
stays on the built-in 3D avatar. Closing the preview POSTs `/api/realtime/conversation/end` so
the vendor conversation frees its concurrent-session slot immediately.

## The one prerequisite for spoken replies: a public URL

Tavus's servers call our custom-LLM endpoint to produce each reply. On `localhost` they can't
reach it, so the replica **renders and greets** but stays silent on HCP turns (`reachableLlm:false`
flags this). To get the full loop locally, expose the app and set `NEXUSREP_PUBLIC_URL` to it
(e.g. `cloudflared tunnel --url http://localhost:3000` or an ngrok URL, or a deploy). Then a
freshly-created persona points its custom-LLM at that URL and the gated replies flow through.
