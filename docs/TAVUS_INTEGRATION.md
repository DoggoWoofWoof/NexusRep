# Tavus CVI integration — feature map

How every Tavus Conversational Video Interface (CVI) feature links to NexusRep, and
what activates when you set `TAVUS_API_KEY`. Contract sourced from docs.tavus.io
(base `https://tavusapi.com/v2`, auth header `x-api-key`).

## The one rule that shapes everything

Tavus must **never generate an answer to an HCP** — that would bypass the compliance
gate. So Tavus is the **face + voice + ears + transport**, and **our orchestrator is the
brain**. We do this with Tavus's **custom-LLM layer**: the persona's `layers.llm.base_url`
points at our OpenAI-compatible endpoint, so Tavus sends each transcribed HCP turn to us,
we run classify → route → grounding → compliance gate, and the replica speaks **only our
approved text**.

```
HCP speaks → Tavus STT → POST /api/tavus/llm/chat/completions
  → our orchestrator (gate) → approved text (SSE) → Tavus TTS → replica speaks it
```

## Feature-by-feature mapping

| Tavus feature | NexusRep mapping | Status |
|---|---|---|
| **Persona (PAL)** `system_prompt`, `context`, `layers` | Built per session by `TavusRealtimeProvider.ensurePersona` (or reuse `TAVUS_PERSONA_ID`) | ✅ wired |
| **Replica / Face** (video avatar) | `RealtimeSessionConfig.replicaId` ← `TAVUS_REPLICA_ID` | ✅ wired (needs a replica id) |
| **Create Conversation** → `conversation_url` | `startSession()` → `RealtimeSession.transportUrl` (+ `token`) | ✅ wired |
| **Custom greeting** | `RealtimeSessionConfig.customGreeting` → `custom_greeting` | ✅ wired |
| **Conversational context** | `config.context` → `conversational_context` (no PHI) | ✅ wired |
| **Custom LLM** (`layers.llm.base_url`) | → `POST /api/tavus/llm/chat/completions` = our compliance orchestrator | ✅ wired + tested |
| **Tool / function calling** | `config.tools[{name,description,parameters}]` → persona `layers.llm.tools`; escalation routing also handled inside our LLM endpoint | ✅ wired (server side) |
| **Echo / interrupt** (verbatim speech) | `sendSystemEvent` recorded for client replay over the Daily data channel; used to force **verbatim ISI** | 🟡 server-recorded; client replay is the last-mile UI |
| **STT hotwords** (drug names) | `config.hotwords` → `layers.stt.hotwords` (Milvexian, LIBREXIA, Factor XIa) | ✅ wired |
| **TTS voice** | `config.voice.voiceId` → `layers.tts.external_voice_id` | ✅ wired |
| **Language / multilingual** | `config.language` → conversation `properties.language` | ✅ wired |
| **Audio-only mode** | `config.audioOnly` → `audio_only` | ✅ wired |
| **End conversation** | `endSession()` → `POST /conversations/{id}/end` | ✅ wired |
| **Transport (Daily/WebRTC)** | `transportUrl` is a Daily room; client joins with `@daily-co/daily-js` | 🟡 needs the client join component (below) |
| **Utterance / tool_call events** | Received client-side over the Daily data channel | 🟡 client-side listener |
| **Perception (Raven vision)** | Persona `layers.perception` — available, not needed for the HCP rep | ⚪ optional |
| **Guardrails / objectives / memory / documents** | Persona-level — our compliance gate already enforces this; can be layered on | ⚪ optional |
| **Recording / transcription / callbacks** | `properties.enable_recording`, `callback_url` — wire a `/api/tavus/webhook` when needed. Keep raw patient data out of recordings (hard rule) | ⚪ optional |
| **Avatar as a separate provider** | Not needed — in Tavus mode the avatar IS the realtime replica | ✅ by design |

## Activate it

```
TAVUS_API_KEY=<key>
TAVUS_REPLICA_ID=<stock or custom replica id>
NEXUSREP_PUBLIC_URL=https://<publicly-reachable-app-url>   # so Tavus can call our LLM endpoint
TAVUS_LLM_KEY=<any shared secret>                          # optional, authenticates Tavus→us
```
With no key, `getRealtimeProvider()` returns the mock and the HCP view uses the built-in
free 3D avatar — the app never breaks.

## Verified against the live API (2026-07-08)

Validated with a real key + stock replica **Charlie** (`rf4703150052`):
- `GET /v2/replicas` → 200 (key valid).
- `POST /v2/personas` (our exact body: custom-LLM layer + STT hotwords) → 200.
- `POST /v2/conversations` → 200, returns a real Daily join URL; `POST /…/end` → 200.

Two things the docs don't spell out that the live API enforces (both fixed):
1. A custom LLM requires **both** `base_url` **and** `api_key` — we always send a non-empty
   `api_key` (defaults to the `TAVUS_LLM_KEY` shim).
2. You may **not** set `tts.external_voice_id` with the default STT engine — omit it and the
   replica uses its own default voice.

## Client join — built

`POST /api/realtime/conversation` (vendor-neutral) opens the conversation and returns
`{ provider, configured, conversationUrl, token, reachableLlm }`.
`src/app/_components/VideoAgentStage.tsx` is vendor-agnostic: it picks a client transport by the
returned `provider` name (`src/app/_components/video-transport.ts` — the ONLY client file that
knows Tavus's Daily/echo/utterance protocol), renders the agent's video + audio, and is toggled
by the **"Video rep"** button on `/hcp`. With no key it reports `configured:false` and the view
stays on the built-in 3D avatar. Closing the preview POSTs `/api/realtime/conversation/end` so
the vendor conversation frees its concurrent-session slot immediately.

## The one prerequisite for spoken replies: a public URL

Tavus's servers call our custom-LLM endpoint to produce each reply. On `localhost` they can't
reach it, so the replica **renders and greets** but stays silent on HCP turns (`reachableLlm:false`
flags this). To get the full loop locally, expose the app and set `NEXUSREP_PUBLIC_URL` to it
(e.g. `cloudflared tunnel --url http://localhost:3000` or an ngrok URL, or a deploy). Then a
freshly-created persona points its custom-LLM at that URL and the gated replies flow through.
