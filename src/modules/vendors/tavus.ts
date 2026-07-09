/**
 * Tavus Conversational Video Interface adapter (brief §19 — realtime/avatar
 * behind the RealtimeProvider interface). Tavus provides the video replica, STT,
 * TTS and WebRTC transport; it does NOT decide what the rep says. We point the
 * persona's custom-LLM layer at our own compliance-gated endpoint, so every
 * reply is produced by our orchestrator (classify → route → gate) — Tavus never
 * free-forms an answer to an HCP. No Tavus type leaks past this file.
 *
 * REST contract (docs.tavus.io): base https://tavusapi.com/v2, auth `x-api-key`.
 *   POST /personas         → { persona_id }
 *   POST /conversations    → { conversation_id, conversation_url, status, meeting_token? }
 *   POST /conversations/{id}/end
 *
 * Realtime interactions (echo/interrupt/tool-result, utterance/tool_call events)
 * happen over the Daily data channel on the CLIENT, not this server adapter, so
 * sendSystemEvent/sendToolResult are recorded here but delivered client-side.
 */

import type {
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSystemEvent,
  ToolResult,
} from "./types";

export interface TavusConfig {
  apiKey: string;
  baseUrl: string;
  replicaId: string;
  personaId?: string;
  timeoutMs?: number;
}

interface CreatePersonaResponse { persona_id?: string }
interface CreateConversationResponse {
  conversation_id?: string;
  conversation_url?: string;
  status?: string;
  meeting_token?: string;
}

// Process-wide cache of ONE persona PER BRAND (keyed by personaCacheKey), so every session
// reuses its brand's persona instead of spawning a new "pal" each time — and a second brand
// in the same process can never reuse/PATCH the first brand's persona. `prompts` tracks the
// last-applied system prompt per key so we update in place (PATCH) when it changes.
const createdPersonas = new Map<string, string>();
const personaPrompts = new Map<string, string>();

export class TavusRealtimeProvider implements RealtimeProvider {
  readonly name = "tavus";
  private conversationId: string | null = null;
  /** Recorded app→CVI intents; the browser replays these over the Daily channel. */
  readonly systemEvents: RealtimeSystemEvent[] = [];
  readonly toolResults: ToolResult[] = [];

  constructor(private readonly cfg: TavusConfig) {}

  private async api<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    // 15s default: observed live that first-boot persona create/patch + conversation create
    // can exceed 8s, which made the FIRST video call of a session fail (configured:false)
    // and succeed only on retry.
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { "x-api-key": this.cfg.apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`tavus ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the persona to use. Priority: an explicitly-configured persona (env/config), else the
   * ONE we've already created this process. Only when none exists do we create a new persona — so
   * we never spawn a fresh "pal" per session. On reuse, if the brand's system prompt changed, we
   * UPDATE the existing persona in place (best-effort PATCH) instead of recreating it.
   */
  private async ensurePersona(config: RealtimeSessionConfig): Promise<string> {
    const cacheKey = config.personaCacheKey ?? "default";
    const existing = config.personaId ?? this.cfg.personaId ?? createdPersonas.get(cacheKey);
    if (existing) {
      if (config.systemPrompt && config.systemPrompt !== personaPrompts.get(cacheKey)) {
        try {
          // Tavus persona update is JSON Patch (RFC 6902).
          await this.api(`/personas/${existing}`, { method: "PATCH", body: JSON.stringify([{ op: "replace", path: "/system_prompt", value: config.systemPrompt }]) });
          personaPrompts.set(cacheKey, config.systemPrompt);
        } catch (e) {
          // Reuse the persona as-is, but SAY so — a silently-stale system prompt is
          // exactly the kind of failure an operator needs to see.
          console.error("[tavus] persona update failed; reusing existing persona:", e instanceof Error ? e.message : e);
        }
      }
      return existing;
    }

    const llm: Record<string, unknown> = {};
    if (config.customLlm) {
      llm.base_url = config.customLlm.baseUrl;
      // Tavus REQUIRES both base_url and api_key for a custom LLM (verified against
      // the live API). Our endpoint only enforces it when TAVUS_LLM_KEY is set, so a
      // non-empty placeholder is always safe.
      llm.api_key = config.customLlm.apiKey || "nexusrep";
      llm.model = config.customLlm.model ?? "nexusrep-compliance";
      // Tavus can begin processing partial transcriptions before the user fully stops
      // speaking. We still final-gate on our side before output, but this reduces
      // perceived latency in the CVI pipeline when supported.
      llm.speculative_inference = true;
    }
    if (config.tools?.length) {
      llm.tools = config.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } },
      }));
    }
    const layers: Record<string, unknown> = {};
    if (Object.keys(llm).length) layers.llm = llm;
    if (config.hotwords?.length) layers.stt = { hotwords: config.hotwords.join(", ") };
    if (config.voice?.voiceId) layers.tts = { external_voice_id: config.voice.voiceId };

    const body = {
      // Stable, per-brand name (not per-session) — one persona per brand, reused across sessions.
      persona_name: cacheKey === "default" ? "NexusRep compliant rep" : `NexusRep compliant rep · ${cacheKey}`,
      system_prompt: config.systemPrompt,
      default_replica_id: config.replicaId ?? this.cfg.replicaId,
      pipeline_mode: "full",
      ...(Object.keys(layers).length ? { layers } : {}),
    };
    const r = await this.api<CreatePersonaResponse>("/personas", { method: "POST", body: JSON.stringify(body) });
    if (!r.persona_id) throw new Error("tavus: no persona_id returned");
    createdPersonas.set(cacheKey, r.persona_id);
    personaPrompts.set(cacheKey, config.systemPrompt);
    return r.persona_id;
  }

  async startSession(config: RealtimeSessionConfig): Promise<RealtimeSession> {
    const personaId = await this.ensurePersona(config);
    const replicaId = config.replicaId ?? this.cfg.replicaId;
    const body = {
      persona_id: personaId,
      ...(replicaId ? { replica_id: replicaId } : {}),
      conversation_name: config.sessionId,
      ...(config.customGreeting ? { custom_greeting: config.customGreeting } : {}),
      ...(config.context ? { conversational_context: config.context } : {}),
      ...(config.audioOnly ? { audio_only: true } : {}),
      ...(config.callbackUrl ? { callback_url: config.callbackUrl } : {}),
      properties: {
        // NexusRep renders the review transcript itself from the audited session.
        // Tavus captions would create a second, sometimes mismatched subtitle layer over the face.
        enable_closed_captions: false,
        ...(config.record ? { enable_recording: true } : {}),
        ...(config.language ? { language: config.language } : {}),
      },
    };
    const r = await this.api<CreateConversationResponse>("/conversations", { method: "POST", body: JSON.stringify(body) });
    this.conversationId = r.conversation_id ?? null;
    return {
      id: r.conversation_id ?? config.sessionId,
      provider: this.name,
      startedAt: Date.now(),
      status: r.status,
      transportUrl: r.conversation_url,
      token: r.meeting_token,
    };
  }

  async sendSystemEvent(event: RealtimeSystemEvent): Promise<void> {
    // Delivered client-side over the Daily data channel (echo / interrupt /
    // append-context). Recorded here so the app can replay it on the client.
    this.systemEvents.push(event);
  }

  async sendToolResult(result: ToolResult): Promise<void> {
    // Tool routing runs inside our custom-LLM endpoint; recorded for parity.
    this.toolResults.push(result);
  }

  async endSession(): Promise<void> {
    if (!this.conversationId) return;
    try {
      await this.api(`/conversations/${this.conversationId}/end`, { method: "POST" });
    } catch {
      /* best-effort; conversation frees on timeout regardless */
    }
    this.conversationId = null;
  }
}
