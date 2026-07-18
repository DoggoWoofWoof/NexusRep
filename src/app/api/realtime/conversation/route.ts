/**
 * Starts a live video conversation for the HCP preview and returns the join URL.
 * Vendor-neutral: the concrete provider comes from getRealtimeProvider() (an env
 * choice), and the persona's custom-LLM layer points at our compliance endpoint,
 * so the video agent only ever speaks approved, gated text. When no provider is
 * configured the resolver returns the mock (no join URL) and we report
 * `configured: false` so the UI falls back to the built-in 3D avatar.
 */

import { NextResponse } from "next/server";
import { limited } from "@lib/rate-limit";
import { asId } from "@lib/ids";
import { getContainerForUser, currentUserId } from "@lib/container";
import { env } from "@lib/env";
import { getRealtimeProvider, resolveDefaultAgentId } from "@modules/vendors";
import { resolveBrandProfile, setupAnswersOf } from "@modules/brand";
import { setActiveCall } from "@lib/active-call";
import { logServerActivity } from "@lib/activity-log";

export const dynamic = "force-dynamic";

const LLM_PROBE_TIMEOUT_MS = 5000;
const LLM_PROBE_CACHE_MS = 60_000;
let llmProbeCache: { baseUrl: string; at: number; ok: boolean } | null = null;
const START_DEDUPE_MS = 30_000;

type ConversationStartPayload = {
  provider: string;
  configured: boolean;
  conversationUrl: string | null;
  token: string | null;
  sessionId: string | null;
  reachableLlm: boolean;
  note: string;
  greeting?: string | null;
};

const inFlightStarts = new Map<string, Promise<ConversationStartPayload>>();
const recentStarts = new Map<string, { at: number; payload: ConversationStartPayload }>();

// Per-OWNER custom-LLM URL. Tavus calls this cookie-less, so the owner in the path is how the
// endpoint knows which account's container the turn belongs to — the concurrent-safe alternative to
// a single global. Public doctor links (no owner) use the plain endpoint (default container).
function tavusLlmBaseUrl(ownerUserId: string | null): string {
  const base = env.publicBaseUrl.replace(/\/$/, "");
  return ownerUserId ? `${base}/api/tavus/llm/o/${encodeURIComponent(ownerUserId)}` : `${base}/api/tavus/llm`;
}

async function probePublicLlmReachability(): Promise<boolean> {
  const baseUrl = env.publicBaseUrl.replace(/\/$/, "");
  if (/localhost|127\.0\.0\.1/.test(baseUrl)) return false;
  if (llmProbeCache && llmProbeCache.baseUrl === baseUrl && Date.now() - llmProbeCache.at < LLM_PROBE_CACHE_MS) {
    return llmProbeCache.ok;
  }
  let ok = false;
  try {
    const probe = await fetch(`${baseUrl}/api/models`, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS) });
    ok = probe.ok;
  } catch {
    // A cold Next/Render/Cloudflare tunnel can miss a short probe while Tavus's real custom-LLM
    // callback succeeds a moment later. Do not disable authoritative server-side transcript/slide
    // logging just because this diagnostic timed out; only localhost is definitely unreachable.
    ok = true;
  }
  llmProbeCache = { baseUrl, at: Date.now(), ok };
  return ok;
}

export async function POST(req: Request): Promise<NextResponse> {
  const limit = limited(req, "startCall");
  if (limit) return limit;
  try {
    const body = (await req.json().catch(() => ({}))) as { hcpId?: unknown; startNonce?: unknown };
    const ownerUserId = await currentUserId();
    const startNonce = typeof body.startNonce === "string" ? body.startNonce.trim().slice(0, 120) : "";
    const dedupeKey = startNonce ? `${ownerUserId ?? "__default__"}:${startNonce}` : "";
    if (dedupeKey) {
      const recent = recentStarts.get(dedupeKey);
      if (recent && Date.now() - recent.at < START_DEDUPE_MS) return NextResponse.json(recent.payload);
      const existing = inFlightStarts.get(dedupeKey);
      if (existing) return NextResponse.json(await existing);
      const started = startConversation(body, ownerUserId)
        .then((payload) => {
          recentStarts.set(dedupeKey, { at: Date.now(), payload });
          return payload;
        })
        .finally(() => {
          inFlightStarts.delete(dedupeKey);
          for (const [key, value] of recentStarts) {
            if (Date.now() - value.at > START_DEDUPE_MS) recentStarts.delete(key);
          }
        });
      inFlightStarts.set(dedupeKey, started);
      return NextResponse.json(await started);
    }
    return NextResponse.json(await startConversation(body, ownerUserId));
  } catch (error) {
    // Never return an HTML 500 — the client parses this as JSON and would crash with
    // "Unexpected token '<'". Always hand back a clean, actionable payload.
    console.error("[realtime/conversation]", error);
    return NextResponse.json(
      {
        provider: "tavus",
        configured: false,
        conversationUrl: null,
        token: null,
        sessionId: null,
        reachableLlm: false,
        note: `Couldn't start the video rep: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 200 },
    );
  }
}

async function startConversation(body: { hcpId?: unknown }, ownerUserId: string | null): Promise<ConversationStartPayload> {
  // Resolve the container owner explicitly (not just getContainer()) so we can record it: the
  // vendor's cookie-less callback (/api/tavus/llm) must reload THIS SAME per-user container to find
  // the call's session. Without it the callback hit the default container, missed the session, and
  // started a fresh one per turn — re-delivering the ISI every reply.
  const c = await getContainerForUser(ownerUserId);
  const provider = getRealtimeProvider();
  // Persona is brand config resolved from the Setup Assistant's answers — so what the brand
  // user set by chatting (name / greeting / audience) is what the live replica speaks.
  const studioSnap = await c.studio.get(c.demo.aiRepId);
  const draft = studioSnap?.draft;
  const persona = resolveBrandProfile(c.brand, setupAnswersOf(draft)).persona;
  // The Studio's Agent gallery selection wins over the default — this is how "pick a different
  // agent (face + voice)" reaches the live call. With no selection, the default is Charlie
  // (resolved by name from the gallery), matching what the Agent gallery shows.
  const agentId = studioSnap?.appearance?.agentId || (await resolveDefaultAgentId());

  // Identity: honor the invite link's hcpId only when it resolves to a real cohort member.
  // No real cohort member → this is a BRAND-USER PREVIEW (we use /hcp for preview since Launch/invite
  // isn't wired), so mark it: the session shows as "Preview", never a doctor's name, and an empty one
  // can be pruned as stray clutter.
  const isRealHcp = typeof body.hcpId === "string" && c.targeting.has(body.hcpId);
  const hcpId = isRealHcp ? asId<"hcp_id">(body.hcpId as string) : c.demo.hcpId;
  // Each video call is its own reviewable session, so its transcript is exactly
  // that call (not pooled into the shared demo session). The recording attaches
  // to it via the recording_ready webhook (keyed by the Tavus conversation id).
  const hist = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId, preview: !isRealHcp });
  // Mark this as the active call so /api/tavus/llm logs the authoritative transcript here (with
  // slideIds), and log the opening greeting once server-side (Tavus speaks it directly, not via
  // the LLM endpoint, so the endpoint never sees it).
  setActiveCall({ sessionId: hist.id, userId: ownerUserId });
  if (persona.customGreeting) {
    await c.sessions.appendTurn(hist.id, { speaker: "rep", text: persona.customGreeting });
    await c.audit.record(hist.id, "response_output", { route: "greeting", text: persona.customGreeting, sourceIds: [], greeting: true });
  }

  // Tavus STT receives these as hotwords, so proper nouns are biased BEFORE the transcript reaches
  // our correction/classification path. Include known mis-hear shapes from live testing; they help
  // Deepgram-medical snap toward the right phrase without changing the approved-content model.
  const tavusHotwords = Array.from(new Set([
    ...persona.hotwords,
    "Milvexian",
    "milvexian",
    "Milvaxian",
    "Mylovaxia",
    "Milovaxia",
    "Mylovexia",
    "my vaccine",
    "BILL vaccine",
    "LIBREXIA",
    "LIBRAXIA",
    "LEBREXIA",
    "LEBIREXIA",
    "LBILE",
    "LIBILE",
    "Lipoaxial",
    "LIBREXIA STROKE",
    "LIBREXIA ACS",
    "LIBREXIA AF",
    "Factor XIa",
    "FXIa",
  ].map((term) => term.trim()).filter(Boolean)));

  // Per-conversation callback URL: it carries the shared key (so callbacks are verifiable) AND the
  // container OWNER, because the recording_ready callback fires LATER (cookie-less, possibly after a
  // restart) and must reload the SAME per-user container the session lives in — otherwise it looks
  // in the default container, never finds the session, and the recording is silently dropped (the
  // "everything recorded except the video" bug). Owner is the internal username, gated by the key.
  const cbParams = new URLSearchParams();
  if (env.tavusLlmKey) cbParams.set("k", env.tavusLlmKey);
  if (ownerUserId) cbParams.set("u", ownerUserId);
  const startArgs = {
      record: true,
      callbackUrl: `${env.publicBaseUrl}/api/tavus/webhook${cbParams.toString() ? `?${cbParams.toString()}` : ""}`,
      sessionId: hist.id,
      // One PAL per (brand, OWNER): each account's persona carries its own per-owner custom-LLM URL
      // so a cookie-less Tavus turn resolves to the right account's container. Still reused across
      // that owner's sessions (patched in place), not spun up per call. Public links (no owner) share
      // the brand's default PAL.
      personaCacheKey: ownerUserId ? `${c.brand.brandId}:${ownerUserId}` : c.brand.brandId,
      systemPrompt: persona.systemPrompt,
      customGreeting: persona.customGreeting,
      context: persona.context,
      customLlm: {
        // Per-OWNER URL (stable across that owner's sessions). The session within the owner's
        // container is bound via the active-call map; the URL only encodes WHICH account, so a
        // cookie-less turn lands in the right container even with another account on video at once.
        baseUrl: tavusLlmBaseUrl(ownerUserId),
        apiKey: env.tavusLlmKey || undefined,
        model: "nexusrep-compliance",
      },
      agentId,
      hotwords: tavusHotwords,
      language: persona.language,
      tools: [],
      // Routing (off-label→MSL, AE→PV) is handled inside our custom-LLM endpoint, so
      // no inline persona tools are needed. External tool-calling would use Tavus's
      // /v2/tools registry. No external_voice_id — the replica uses its default voice.
    };

  // Probe our public compliance callback in parallel with Tavus startup. It is only a diagnostic
  // note for the client; it should never add a serial 5s wait to "agent joining".
  const reachableLlmPromise = probePublicLlmReachability();

  let session;
  try {
    session = await provider.startSession(startArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // At the concurrent-conversation cap (now 3 slots), REPORT it — do NOT force-evict. The old
    // endActiveConversations() ended EVERY live conversation to free a slot, which would kill a
    // colleague's in-progress call. A closed preview already ends its own conversation, so the cap
    // is only hit by genuine concurrent use; the honest answer is "busy", not hijacking someone.
    const atCapacity = /maximum concurrent conversations/i.test(message);
    return {
      provider: provider.name, configured: false, conversationUrl: null, token: null, sessionId: hist.id,
      reachableLlm: !/localhost|127\.0\.0\.1/.test(env.publicBaseUrl),
      note: atCapacity
        ? "All video-rep lines are busy right now (up to 3 at once). Please close an open preview or try again in a moment."
        : `The DocNexus Agent could not start: ${message}`,
    };
  }

  // Link the Tavus conversation id to our per-call session, so the recording_ready
  // callback attaches the playback URL to the same session the transcript lives in.
  if (session.transportUrl) {
    await c.sessions.setVendorConversation(hist.id, session.id);
  }

  void logServerActivity({
    user: ownerUserId ?? undefined,
    category: "video",
    action: session.transportUrl ? "Video rep connected" : "Video rep started (mock avatar)",
    target: hist.id,
    sessionId: hist.id,
    severity: "notice",
    metadata: { provider: provider.name, vendorConversationId: session.id ?? null },
  });

  const reachableLlm = await reachableLlmPromise;
  return {
    provider: provider.name,
    configured: Boolean(session.transportUrl),
    conversationUrl: session.transportUrl ?? null,
    token: session.token ?? null,
    // Our reviewable session id (the client logs utterances here). The Tavus
    // conversation id is separate and lives on the session as vendorConversationId.
    sessionId: hist.id,
    // The opening line for the CLIENT to speak as a normal (interruptible) echoed utterance —
    // we no longer use Tavus's custom_greeting, which the platform makes non-interruptible.
    greeting: persona.customGreeting || null,
    reachableLlm,
    note: !session.transportUrl
      ? "The DocNexus Agent isn't configured yet — using the built-in avatar meanwhile."
      : reachableLlm
        ? "Live DocNexus Agent — replies produced by our compliance endpoint."
        : "The DocNexus Agent renders and greets, but replies won't flow: the public URL isn't reachable. Restart it and update NEXUSREP_PUBLIC_URL.",
  };
}
