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
  AgentCatalog,
  AgentPreviewStudio,
  AgentPreviewClip,
  AgentSummary,
  ToolResult,
} from "./types";

export interface TavusConfig {
  apiKey: string;
  baseUrl: string;
  replicaId: string;
  personaId?: string;
  /** Tavus STT engine for layers.stt.stt_engine (e.g. "tavus-deepgram-medical" for clinical terms). */
  sttEngine?: string;
  tts?: {
    engine?: string;
    model?: string;
    speed?: number;
    emotionControl?: boolean;
  };
  timeoutMs?: number;
}

interface CreatePersonaResponse { persona_id?: string }
interface TavusVideo {
  video_id?: string;
  video_name?: string;
  status?: string;
  download_url?: string;
  stream_url?: string;
  hosted_url?: string;
}
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
const personaLayerSignatures = new Map<string, string>();
/** In-flight creations — two concurrent first sessions for a brand must share ONE
 *  persona POST instead of each creating (and leaking) their own. */
const personaCreations = new Map<string, Promise<string>>();

export class TavusRealtimeProvider implements RealtimeProvider, AgentCatalog, AgentPreviewStudio {
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
    const personaName = cacheKey === "default" ? "NexusRep compliant rep" : `NexusRep compliant rep · ${cacheKey}`;
    const layers = this.layersFor(config);
    const layerSignature = JSON.stringify(layers);
    // Reuse order: explicit config/env id → this-process cache → an EXISTING persona with our name
    // already on the account → only then create. The name lookup is what makes reuse survive a
    // process restart/redeploy: `createdPersonas` is in-memory, so without it every deploy (and
    // every idle spin-down) minted a brand-new PAL — the "why does it change PALs" leak.
    let existing = config.personaId ?? this.cfg.personaId ?? createdPersonas.get(cacheKey);
    if (!existing) {
      const found = await this.findPersonaByName(personaName);
      if (found) {
        existing = found;
        createdPersonas.set(cacheKey, found); // skip the lookup for the rest of this process
      }
    }
    if (existing) {
      const patches: Record<string, unknown>[] = [];
      if (config.systemPrompt && config.systemPrompt !== personaPrompts.get(cacheKey)) {
        patches.push({ op: "replace", path: "/system_prompt", value: config.systemPrompt });
      }
      if (layerSignature !== personaLayerSignatures.get(cacheKey)) {
        // "add" to an existing object member replaces it per JSON Patch; this keeps old PALs fast
        // when we add a latency layer after the persona was first created.
        patches.push({ op: "add", path: "/layers", value: layers });
      }
      if (patches.length) {
        try {
          // Tavus persona update is JSON Patch (RFC 6902).
          await this.api(`/personas/${existing}`, { method: "PATCH", body: JSON.stringify(patches) });
          personaPrompts.set(cacheKey, config.systemPrompt);
          personaLayerSignatures.set(cacheKey, layerSignature);
        } catch (e) {
          // Reuse the persona as-is, but SAY so — a silently-stale system prompt is
          // exactly the kind of failure an operator needs to see.
          console.error("[tavus] persona update failed; reusing existing persona:", e instanceof Error ? e.message : e);
        }
      }
      return existing;
    }

    const body = {
      // Stable, per-brand name (not per-session) — one persona per brand, reused across sessions
      // (and found by name after a restart, so we never create a second one for the same brand).
      persona_name: personaName,
      system_prompt: config.systemPrompt,
      default_replica_id: config.agentId ?? this.cfg.replicaId,
      pipeline_mode: "full",
      ...(Object.keys(layers).length ? { layers } : {}),
    };
    const inFlight = personaCreations.get(cacheKey);
    if (inFlight) return inFlight;
    const creation = this.api<CreatePersonaResponse>("/personas", { method: "POST", body: JSON.stringify(body) })
      .then((r) => {
        if (!r.persona_id) throw new Error("tavus: no persona_id returned");
        createdPersonas.set(cacheKey, r.persona_id);
        personaPrompts.set(cacheKey, config.systemPrompt);
        personaLayerSignatures.set(cacheKey, layerSignature);
        return r.persona_id;
      })
      .finally(() => {
        personaCreations.delete(cacheKey);
      });
    personaCreations.set(cacheKey, creation);
    return creation;
  }

  /** Find an existing persona on the account by its exact name (best-effort). This is what lets
   *  reuse survive a process restart — otherwise the in-memory cache is empty on boot and we'd
   *  create a duplicate PAL. Returns undefined on any error so the caller falls back to creating. */
  private async findPersonaByName(name: string): Promise<string | undefined> {
    try {
      const res = await this.api<{ data?: { persona_id?: string; persona_name?: string }[] }>("/personas?limit=100", { method: "GET" });
      const list = Array.isArray(res) ? (res as { persona_id?: string; persona_name?: string }[]) : res.data ?? [];
      return list.find((p) => p.persona_name === name)?.persona_id;
    } catch {
      return undefined;
    }
  }

  private layersFor(config: RealtimeSessionConfig): Record<string, unknown> {
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
    // STT layer: pick the transcription engine (e.g. tavus-deepgram-medical so clinical/proper-noun
    // terms transcribe correctly) and prioritize the product/program names as hotwords.
    const sttEngine = this.cfg.sttEngine && this.cfg.sttEngine !== "tavus-auto" ? this.cfg.sttEngine : undefined;
    if (sttEngine || config.hotwords?.length) {
      layers.stt = {
        ...(sttEngine ? { stt_engine: sttEngine } : {}),
        ...(config.hotwords?.length ? { hotwords: config.hotwords.join(", ") } : {}),
      };
    }
    layers.tts = {
      // Be explicit instead of relying on the PAL's creation-era defaults. Existing cached
      // personas are patched when this signature changes, which is exactly what we want for
      // latency tuning on Render without manually recreating every Tavus persona.
      tts_engine: this.cfg.tts?.engine ?? "cartesia",
      tts_model_name: this.cfg.tts?.model ?? "sonic-3",
      tts_emotion_control: this.cfg.tts?.emotionControl ?? false,
      voice_settings: { speed: this.cfg.tts?.speed ?? 1.0 },
      ...(config.voice?.voiceId ? { external_voice_id: config.voice.voiceId } : {}),
    };
    // Lowest-latency conversational flow per Tavus docs: sparrow-1 turn detection (fastest),
    // turn_taking_patience "low" (eager to respond once the HCP stops), pal_interruptibility "high"
    // (stops instantly when the HCP starts speaking — snappiest barge-in). These are the only
    // turn/latency knobs the API exposes; the residual is Tavus's own STT/turn processing.
    layers.conversational_flow = {
      turn_detection_model: "sparrow-1",
      turn_taking_patience: "low",
      pal_interruptibility: "high",
      voice_isolation: "near",
      idle_engagement: "off",
    };
    return layers;
  }

  async startSession(config: RealtimeSessionConfig): Promise<RealtimeSession> {
    const personaId = await this.ensurePersona(config);
    const replicaId = config.agentId ?? this.cfg.replicaId;
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
    await this.endConversation(this.conversationId);
    this.conversationId = null;
  }

  async endConversation(conversationId: string): Promise<void> {
    if (!conversationId) return;
    try {
      await this.api(`/conversations/${conversationId}/end`, { method: "POST" });
    } catch {
      /* best-effort; a conversation also frees on Tavus's inactivity timeout */
    }
  }

  /** The vendor's stock library ships novelty / seasonal characters (Santa, a zombie, an elf,
   *  costumed personas, etc.) alongside the business presenters. They have no place representing
   *  a pharma rep to a doctor, so the stock sweep drops any whose name matches this. Personal
   *  agents the brand trained are never filtered. Extend the list rather than loosening it. */
  private static readonly NOVELTY_STOCK = /\b(santa|claus|s?kringle|elf|reindeer|rudolph|christmas|xmas|holiday|hanukkah|kwanzaa|new[\s-]?year|halloween|spooky|ghost|zombie|vampire|witch|skeleton|pumpkin|jack[\s-]?o|thanksgiving|turkey|easter|bunny|valentine|cupid|leprechaun|patrick|costume|cosplay|superhero|santa'?s|mrs\.?\s*claus|gnome|fairy|wizard|pirate|clown|mascot)\b/i;

  /** Map one raw Tavus replica record into the canonical AgentSummary. This is the ONLY
   *  place the vendor's "replica" vocabulary exists — callers only see agents. */
  private static toSummary(raw: Record<string, unknown>, fallbackKind: "stock" | "personal"): AgentSummary | null {
    const id = typeof raw.replica_id === "string" ? raw.replica_id : "";
    if (!id) return null;
    const rawStatus = String(raw.status ?? "").toLowerCase();
    const status: AgentSummary["status"] =
      rawStatus === "error" ? "error" : /train|start|queue|progress/.test(rawStatus) ? "training" : "ready";
    const kind: AgentSummary["kind"] = raw.replica_type === "system" ? "stock" : raw.replica_type === "user" ? "personal" : fallbackKind;
    const thumb = typeof raw.thumbnail_video_url === "string" ? raw.thumbnail_video_url : typeof raw.thumbnail_url === "string" ? raw.thumbnail_url : undefined;
    return {
      id,
      name: (typeof raw.replica_name === "string" && raw.replica_name.trim()) || id,
      kind,
      status,
      ...(thumb ? { thumbnailUrl: thumb } : {}),
    };
  }

  private static parseReplicaList(res: unknown): Record<string, unknown>[] {
    if (Array.isArray(res)) return res as Record<string, unknown>[];
    const data = (res as { data?: unknown } | null)?.data;
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  /** Browse the agent catalog: the account's own agents + the vendor's stock library.
   *  Both calls are best-effort — a failure of one list never hides the other. */
  async listAgents(): Promise<AgentSummary[]> {
    const [mine, stock] = await Promise.all([
      this.api<unknown>("/replicas?limit=100&verbose=true", { method: "GET" }).catch(() => null),
      this.api<unknown>("/replicas?limit=100&replica_type=system&verbose=true", { method: "GET" }).catch(() => null),
    ]);
    const out = new Map<string, AgentSummary>();
    for (const raw of TavusRealtimeProvider.parseReplicaList(mine)) {
      const r = TavusRealtimeProvider.toSummary(raw, "personal");
      if (r) out.set(r.id, r);
    }
    for (const raw of TavusRealtimeProvider.parseReplicaList(stock)) {
      const r = TavusRealtimeProvider.toSummary(raw, "stock");
      // Drop novelty/seasonal stock characters — they can't front a compliant pharma rep.
      if (r && TavusRealtimeProvider.NOVELTY_STOCK.test(r.name)) continue;
      // A personal record wins over the same id appearing in the stock sweep.
      if (r && !out.has(r.id)) out.set(r.id, r);
    }
    return [...out.values()];
  }

  /** Start training a personal agent from footage. Uses one of the plan's custom slots
   *  and takes hours to train — the caller is responsible for warning the user first. */
  async createAgent(input: { name: string; trainVideoUrl: string }): Promise<AgentSummary> {
    const r = await this.api<{ replica_id?: string; status?: string }>("/replicas", {
      method: "POST",
      body: JSON.stringify({ replica_name: input.name, train_video_url: input.trainVideoUrl }),
    });
    if (!r.replica_id) throw new Error("tavus: no replica_id returned");
    return { id: r.replica_id, name: input.name, kind: "personal", status: "training" };
  }

  /**
   * Render (or reuse) a short clip of an agent speaking `script` in ITS OWN voice/face via Tavus
   * video generation (POST /v2/videos). Idempotent by `videoName`: an existing render is reused
   * (ready → its URL; still rendering → "generating"), so we spend credits at most once per
   * (agent, script). A render takes minutes — the caller shows the stock clip until it's ready.
   */
  async ensurePreviewClip(input: { agentId: string; script: string; videoName: string }): Promise<AgentPreviewClip> {
    try {
      const existing = await this.findVideoByName(input.videoName);
      if (existing) return TavusRealtimeProvider.previewFromVideo(existing);
      const created = await this.api<TavusVideo>("/videos", {
        method: "POST",
        body: JSON.stringify({ replica_id: input.agentId, script: input.script, video_name: input.videoName }),
      });
      return TavusRealtimeProvider.previewFromVideo(created);
    } catch (e) {
      console.error("[tavus] preview clip render failed:", e instanceof Error ? e.message : e);
      return { status: "unavailable" };
    }
  }

  private async findVideoByName(name: string): Promise<TavusVideo | undefined> {
    const res = await this.api<{ data?: TavusVideo[] }>("/videos?limit=100", { method: "GET" });
    return (res.data ?? []).find((v) => v.video_name === name);
  }

  private static previewFromVideo(v: TavusVideo): AgentPreviewClip {
    const status = String(v.status ?? "").toLowerCase();
    // Only a DIRECT media URL is playable in a <video> tag. hosted_url is a tavus.video webpage
    // (present even while queued), so it must never be treated as a ready clip.
    const url = v.download_url || v.stream_url || undefined;
    if ((status === "ready" || status === "completed") && url) return { status: "ready", url };
    if (status === "error" || status === "deleted") return { status: "unavailable" };
    return { status: "generating" };
  }

  /** List active conversations and end them all — frees concurrent-conversation slots after
   *  previews that closed without ending (e.g. a tab closed mid-call, or a process restart). */
  async endActiveConversations(): Promise<number> {
    try {
      const res = await this.api<{ data?: { conversation_id?: string; status?: string }[] }>("/conversations?status=active", { method: "GET" });
      const ids = (res.data ?? []).map((c) => c.conversation_id).filter((id): id is string => Boolean(id));
      await Promise.all(ids.map((id) => this.endConversation(id)));
      return ids.length;
    } catch {
      return 0;
    }
  }
}
