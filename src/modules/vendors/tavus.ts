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
import { COMPLIANCE_LLM_MODEL } from "./types";

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

// Valid Tavus STT engines (from the live persona API + docs). Anything else — most commonly a
// mis-pasted env-var NAME as the value — is ignored so it can't 400 persona creation and kill the
// video rep. Extend if Tavus adds engines.
const KNOWN_STT_ENGINES = new Set([
  "tavus-auto", "tavus-whisper", "tavus-turbo", "tavus-advanced", "tavus-parakeet", "tavus-soniox", "tavus-deepgram-medical",
]);

const DEFAULT_PERSONA_NAME = "NexusRep compliant rep";

// Process-wide cache of ONE Tavus PAL for NexusRep, so every session reuses the same PAL instead
// of spawning a new one. The PAL is PATCHED in place when prompt/layers change. `personaCacheKey`
// remains accepted by the interface for future multi-PAL deployments, but this demo/product path
// intentionally keeps one stable PAL because Tavus accounts are otherwise littered with duplicates.
const createdPersonas = new Map<string, string>();
const personaPrompts = new Map<string, string>();
const personaLayerSignatures = new Map<string, string>();
/** In-flight creations — two concurrent first sessions for a brand must share ONE
 *  persona POST instead of each creating (and leaking) their own. */
const personaCreations = new Map<string, Promise<string>>();

export function __resetTavusPersonaCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") return;
  createdPersonas.clear();
  personaPrompts.clear();
  personaLayerSignatures.clear();
  personaCreations.clear();
}

export class TavusRealtimeProvider implements RealtimeProvider, AgentCatalog, AgentPreviewStudio {
  readonly name = "tavus";
  private conversationId: string | null = null;
  /** Recorded app→CVI intents; the browser replays these over the Daily channel. */
  readonly systemEvents: RealtimeSystemEvent[] = [];
  readonly toolResults: ToolResult[] = [];

  constructor(private readonly cfg: TavusConfig) {}

  private async api<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    // Cold starts can involve persona lookup/patch plus conversation creation. A 15s ceiling
    // surfaced as the browser's useless "operation aborted" even though a retry worked. Keep a
    // bounded timeout, but give Tavus enough headroom for first preview after deploy/spin-up.
    const timeoutMs = this.cfg.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { "x-api-key": this.cfg.apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`tavus ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as T;
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        throw new Error(`tavus ${path} timed out after ${Math.round(timeoutMs / 1000)}s while starting the video rep`);
      }
      throw error;
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
    const cacheKey = "default";
    const personaName = DEFAULT_PERSONA_NAME;
    const layers = this.layersFor(config);
    const layerSignature = JSON.stringify(layers);
    // Reuse order: explicit config/env id → this-process cache → an EXISTING NexusRep persona
    // already on the account → only then create. The account may have stale duplicate names from
    // earlier local tunnels, so lookup scores candidates by desired layers instead of picking the
    // first row. This is what makes reuse survive restarts/redeploys without minting new PALs.
    let existing = config.personaId ?? this.cfg.personaId ?? createdPersonas.get(cacheKey);
    if (!existing) {
      const found = await this.findReusablePersona(personaName, layers);
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
        // Tavus persona update is JSON Patch (RFC 6902).
        const applyPatch = (ps: Record<string, unknown>[]) => this.api(`/personas/${existing}`, { method: "PATCH", body: JSON.stringify(ps) });
        try {
          await applyPatch(patches);
          personaPrompts.set(cacheKey, config.systemPrompt);
          personaLayerSignatures.set(cacheKey, layerSignature);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 304 Not Modified is NOT a failure: the persona already matches exactly what we'd PATCH, so
          // Tavus changed nothing. Our desired config is already live — cache it (so we stop re-sending
          // the same PATCH every session) and log it as the benign no-op it is, not an alarming error.
          const sttLayer = (layers as { stt?: Record<string, unknown> }).stt;
          if (/\b304\b/.test(msg)) {
            personaPrompts.set(cacheKey, config.systemPrompt);
            personaLayerSignatures.set(cacheKey, layerSignature);
            console.info("[tavus] persona already up to date (304 Not Modified); reusing:", existing);
          } else if (sttLayer && "stt_engine" in sttLayer && /stt_engine|\bstt\b/i.test(msg)) {
            const sttRest = { ...sttLayer };
            delete sttRest.stt_engine;
            const retryLayers = { ...layers };
            if (Object.keys(sttRest).length) (retryLayers as { stt?: unknown }).stt = sttRest;
            else delete (retryLayers as { stt?: unknown }).stt;
            const retryPatches = patches.map((p) => (p.path === "/layers" ? { ...p, value: retryLayers } : p));
            try {
              await applyPatch(retryPatches);
              console.warn("[tavus] persona STT engine rejected on update; applied the rest without stt_engine:", msg.slice(0, 160));
              personaPrompts.set(cacheKey, config.systemPrompt);
              personaLayerSignatures.set(cacheKey, layerSignature); // stop re-hammering the failing PATCH each session
            } catch (e2) {
              console.error("[tavus] persona update failed; reusing existing persona:", e2 instanceof Error ? e2.message : e2);
            }
          } else {
            // Reuse the persona as-is, but SAY so — a silently-stale system prompt is
            // exactly the kind of failure an operator needs to see.
            console.error("[tavus] persona update failed; reusing existing persona:", msg.slice(0, 160));
          }
        }
      }
      return existing;
    }

    const body = {
      // Stable product PAL name (not per-session or per-brand) — one NexusRep PAL reused across
      // every session and found by name after a restart if TAVUS_PERSONA_ID is not pinned.
      persona_name: personaName,
      system_prompt: config.systemPrompt,
      default_replica_id: config.agentId ?? this.cfg.replicaId,
      pipeline_mode: "full",
      ...(Object.keys(layers).length ? { layers } : {}),
    };
    const inFlight = personaCreations.get(cacheKey);
    if (inFlight) return inFlight;
    const createPersona = async (createBody: Record<string, unknown>): Promise<string> => {
      const r = await this.api<CreatePersonaResponse>("/personas", { method: "POST", body: JSON.stringify(createBody) });
      if (!r.persona_id) throw new Error("tavus: no persona_id returned");
      return r.persona_id;
    };
    const creation = createPersona(body)
      .catch((e: unknown) => {
        // A rejected STT engine (invalid, or valid but not on this Tavus plan) must NOT sink the
        // whole video rep. Retry once dropping stt_engine (keep hotwords) → starts on default STT.
        const msg = e instanceof Error ? e.message : String(e);
        const stt = (body.layers as { stt?: Record<string, unknown> } | undefined)?.stt;
        if (stt && "stt_engine" in stt && /stt_engine|\bstt\b/i.test(msg)) {
          console.warn("[tavus] persona create rejected the STT engine; retrying with Tavus default:", msg.slice(0, 200));
          const sttRest = { ...stt };
          delete sttRest.stt_engine;
          const retryLayers = { ...(body.layers as Record<string, unknown>) };
          if (Object.keys(sttRest).length) retryLayers.stt = sttRest;
          else delete (retryLayers as { stt?: unknown }).stt;
          return createPersona({ ...body, layers: retryLayers });
        }
        throw e;
      })
      .then((persona_id) => {
        createdPersonas.set(cacheKey, persona_id);
        personaPrompts.set(cacheKey, config.systemPrompt);
        personaLayerSignatures.set(cacheKey, layerSignature);
        return persona_id;
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
  private async findReusablePersona(name: string, desiredLayers?: Record<string, unknown>): Promise<string | undefined> {
    try {
      type PersonaRow = { persona_id?: string; persona_name?: string; layers?: Record<string, unknown> };
      const res = await this.api<{ data?: PersonaRow[] }>("/personas?limit=100", { method: "GET" });
      const list = Array.isArray(res) ? (res as PersonaRow[]) : res.data ?? [];
      const matches = list.filter((p) => typeof p.persona_name === "string" && p.persona_name.startsWith(DEFAULT_PERSONA_NAME) && p.persona_id);
      if (!matches.length) return undefined;
      const desiredLlm = desiredLayers?.llm as Record<string, unknown> | undefined;
      const desiredStt = desiredLayers?.stt as Record<string, unknown> | undefined;
      const desiredTts = desiredLayers?.tts as Record<string, unknown> | undefined;
      const score = (p: PersonaRow) => {
        const layers = p.layers ?? {};
        const llm = layers.llm as Record<string, unknown> | undefined;
        const stt = layers.stt as Record<string, unknown> | undefined;
        const tts = layers.tts as Record<string, unknown> | undefined;
        let s = 0;
        if (p.persona_name === name) s += 1;
        if (desiredLlm?.base_url && llm?.base_url === desiredLlm.base_url) s += 10;
        if (desiredLlm?.model && llm?.model === desiredLlm.model) s += 2;
        if (desiredStt?.stt_engine && stt?.stt_engine === desiredStt.stt_engine) s += 6;
        if (desiredStt?.hotwords && stt?.hotwords === desiredStt.hotwords) s += 2;
        if (desiredTts?.tts_engine && tts?.tts_engine === desiredTts.tts_engine) s += 2;
        if (desiredTts?.tts_model_name && tts?.tts_model_name === desiredTts.tts_model_name) s += 2;
        return s;
      };
      return matches.sort((a, b) => score(b) - score(a))[0]?.persona_id;
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
      llm.model = config.customLlm.model ?? COMPLIANCE_LLM_MODEL;
      // Keep this OFF by default for NexusRep. With a compliance-gated custom LLM, Tavus
      // speculative inference calls the endpoint on growing interim ASR text; that creates
      // multiple approved answers for one doctor utterance and can queue stale TTS. The rep should
      // answer the settled turn. Opt in only for controlled latency experiments.
      llm.speculative_inference = /^(1|true|yes)$/i.test(process.env.NEXUSREP_TAVUS_SPECULATIVE ?? "");
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
    // terms transcribe correctly) and prioritize the product/program names as hotwords. A value
    // that isn't a real Tavus engine (e.g. a mis-pasted env var name) is IGNORED, not sent — an
    // invalid stt_engine 400s persona creation and takes down the whole video rep.
    const configuredStt = this.cfg.sttEngine?.trim();
    let sttEngine: string | undefined;
    if (configuredStt && configuredStt !== "tavus-auto") {
      if (KNOWN_STT_ENGINES.has(configuredStt)) sttEngine = configuredStt;
      else console.warn(`[tavus] ignoring invalid stt_engine "${configuredStt}" (set NEXUSREP_TAVUS_STT to one of ${[...KNOWN_STT_ENGINES].join(", ")}) — using tavus-auto`);
    }
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
    // turn_taking_patience "low" (eager to respond once the HCP stops), interruptibility "high"
    // (stops instantly when the HCP starts speaking — snappiest barge-in). These are the only
    // turn/latency knobs the API exposes; the residual is Tavus's own STT/turn processing.
    layers.conversational_flow = {
      turn_detection_model: "sparrow-1",
      turn_taking_patience: "low",
      // Docs call this pal_interruptibility; the live API also surfaces replica_interruptibility
      // in existing personas. Send both so old/new naming cannot leave the PAL at "medium".
      pal_interruptibility: "high",
      replica_interruptibility: "high",
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
      // NOTE: we deliberately do NOT set custom_greeting. Tavus makes the custom greeting ALWAYS
      // non-interruptible and drops anything the doctor says during it (docs: "The face's greeting
      // is always non-interruptible … these settings only take effect after the greeting
      // completes"). Instead the client speaks the opening as a normal echoed utterance once the
      // replica is live, so it obeys replica_interruptibility and the doctor can barge in over it.
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
