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
  /** Which video agent fronts this session (an AgentSummary id). */
  agentId?: string;
  /** Reuse an existing persona instead of creating one per session. */
  personaId?: string;
  /** Cache key for the auto-created persona (one persona PER BRAND, e.g. the brandId) —
   *  prevents a second brand in the same process reusing/patching the first brand's persona. */
  personaCacheKey?: string;
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

/** One selectable video agent: a face + its bundled voice. Canonical NexusRep object —
 *  vendors call these "replicas" (Tavus), "avatars" (HeyGen), etc.; nothing outside a
 *  vendor adapter ever sees those terms. */
export interface AgentSummary {
  id: string;
  name: string;
  /** stock = provided by the vendor's library; personal = trained on the brand's own footage. */
  kind: "stock" | "personal";
  status: "ready" | "training" | "error";
  thumbnailUrl?: string;
}

/** Optional capability: providers that expose a browsable agent catalog implement this
 *  alongside RealtimeProvider. Callers feature-detect via hasAgentCatalog() — swapping the
 *  vendor never changes a caller. */
export interface AgentCatalog {
  listAgents(): Promise<AgentSummary[]>;
  createAgent(input: { name: string; trainVideoUrl: string }): Promise<AgentSummary>;
}

export function hasAgentCatalog(p: unknown): p is AgentCatalog {
  const c = p as Partial<AgentCatalog> | null;
  return typeof c?.listAgents === "function" && typeof c?.createAgent === "function";
}

export interface RealtimeProvider {
  readonly name: string;
  startSession(config: RealtimeSessionConfig): Promise<RealtimeSession>;
  sendSystemEvent(event: RealtimeSystemEvent): Promise<void>;
  sendToolResult(result: ToolResult): Promise<void>;
  endSession(): Promise<void>;
  /** End ONE conversation by id (client calls this on close so a preview doesn't linger
   *  and eat a concurrent-conversation slot). Best-effort. */
  endConversation(conversationId: string): Promise<void>;
  /** End every currently-active conversation on the account and return how many were ended.
   *  Used to self-heal the "maximum concurrent conversations" cap. Best-effort. */
  endActiveConversations(): Promise<number>;
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
