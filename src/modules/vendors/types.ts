/**
 * Vendor adapter contracts. These interfaces are the ONLY thing core services
 * know about realtime/voice/avatar/CRM providers. No vendor SDK type (Tavus,
 * GPT Realtime, ElevenLabs, Veeva…) may appear outside an adapter implementation
 * (brief §19–20, CLAUDE.md). Mock implementations live in `./mock`.
 */

// ── Realtime ────────────────────────────────────────────────────────────────
export interface RealtimeSessionConfig {
  sessionId: string;
  systemPrompt: string;
  /** Tool schemas the provider may call back into (retrieval, escalation…).
   *  `parameters` is a JSON Schema for function-calling providers (e.g. Tavus). */
  tools: { name: string; description: string; parameters?: Record<string, unknown> }[];
  voice?: VoiceConfig;
  /** Video-avatar id for providers that render one (Tavus replica / "face"). */
  replicaId?: string;
  /** Reuse an existing persona instead of creating one per session. */
  personaId?: string;
  /** Opening line the avatar speaks (disclosure + greeting). */
  customGreeting?: string;
  /** Per-session context appended on top of the persona's context (NO raw PHI). */
  context?: string;
  /**
   * Point the provider's LLM layer at our OWN compliance-gated endpoint so every
   * reply is produced by our orchestrator, not the vendor's model. OpenAI-compatible.
   */
  customLlm?: { baseUrl: string; apiKey?: string; model?: string };
  /** Proper nouns to bias transcription toward (drug/brand names). */
  hotwords?: string[];
  language?: string;
  audioOnly?: boolean;
  /** Record the session for playback (provider stores it; URL arrives via callback). */
  record?: boolean;
  /** Webhook the provider posts lifecycle events to (recording_ready, transcription…). */
  callbackUrl?: string;
}

export interface RealtimeSession {
  id: string;
  provider: string;
  startedAt: number;
  status?: string;
  /** Join URL for the realtime transport (Tavus: the Daily/WebRTC room). */
  transportUrl?: string;
  /** Optional short-lived join token (Tavus meeting_token when auth is required). */
  token?: string;
}

export interface RealtimeSystemEvent {
  type: "compliance_block" | "escalation" | "detail_aid" | "note";
  payload: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  result: unknown;
}

export interface RealtimeProvider {
  readonly name: string;
  startSession(config: RealtimeSessionConfig): Promise<RealtimeSession>;
  sendSystemEvent(event: RealtimeSystemEvent): Promise<void>;
  sendToolResult(result: ToolResult): Promise<void>;
  endSession(): Promise<void>;
}

// ── Voice ───────────────────────────────────────────────────────────────────
export interface VoiceConfig {
  /** Optional explicit voice; omit to use the replica/provider default. */
  voiceId?: string;
  style?: "professional" | "warm" | "clinical";
}

export interface AudioInput {
  bytes: Uint8Array | string;
  mimeType: string;
}

export interface Transcript {
  text: string;
  confidence: number;
}

export interface AudioStream {
  /** Opaque handle/URL to synthesized audio. Mock returns a data descriptor. */
  ref: string;
  durationMs: number;
}

export interface VoiceProvider {
  readonly name: string;
  transcribe(audio: AudioInput): Promise<Transcript>;
  synthesize(text: string, voice: VoiceConfig): Promise<AudioStream>;
}

// ── Avatar ──────────────────────────────────────────────────────────────────
export interface AvatarConfig {
  avatarId: string;
  background?: string;
}

export type SpeakInput = { text: string } | { audioRef: string };

export interface AvatarProvider {
  readonly name: string;
  startAvatar(config: AvatarConfig): Promise<void>;
  speak(input: SpeakInput): Promise<void>;
  showDetailAid(slideId: string): Promise<void>;
  endAvatar(): Promise<void>;
}

// ── CRM (outbox-driven) ───────────────────────────────────────────────────────
export interface CrmEventPayload {
  eventType: string;
  hcpNpi?: string;
  brandId: string;
  campaignId: string;
  sessionId: string;
  [key: string]: unknown;
}

export type CrmDeliveryStatus =
  | "created"
  | "sent"
  | "failed"
  | "needs_mapping"
  | "retrying"
  | "suppressed";

export interface CrmDeliveryResult {
  status: CrmDeliveryStatus;
  detail?: string;
}

export interface CrmAdapter {
  readonly name: string;
  /** Deliver a single outbox event. Never called directly by the UI — the CRM
   *  outbox worker calls this with retry/status tracking (brief §8, §12). */
  deliver(payload: CrmEventPayload): Promise<CrmDeliveryResult>;
}

// ── Retrieval ─────────────────────────────────────────────────────────────────
export interface RetrievalProvider {
  readonly name: string;
  /** Returns candidate canonical IDs ONLY. Eligibility is decided downstream. */
  retrieve(query: {
    text: string;
    filter?: Record<string, string>;
    topK?: number;
  }): Promise<{ refId: string; score: number }[]>;
}
