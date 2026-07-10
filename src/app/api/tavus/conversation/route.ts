/**
 * Starts a Tavus CVI conversation for the HCP preview and returns the join URL.
 * The persona is created with its custom-LLM layer pointed at our compliance
 * endpoint (/api/tavus/llm), so the replica only ever speaks approved, gated
 * text. When no TAVUS_API_KEY is set the resolver returns the mock (no join URL)
 * and we report `configured: false` so the UI can fall back to the 3D avatar.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { env } from "@lib/env";
import { getRealtimeProvider } from "@modules/vendors";
import { resolveBrandProfile, setupAnswersOf } from "@modules/brand";
import { setActiveTavusSession } from "@lib/tavus-session";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  try {
    return await startConversation(req);
  } catch (error) {
    // Never return an HTML 500 — the client parses this as JSON and would crash with
    // "Unexpected token '<'". Always hand back a clean, actionable payload.
    console.error("[tavus/conversation]", error);
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

async function startConversation(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { hcpId?: unknown };
  const c = await getContainer();
  const provider = getRealtimeProvider();
  // Persona is brand config resolved from the Setup Assistant's answers — so what the brand
  // user set by chatting (name / greeting / audience) is what the live replica speaks.
  const draft = (await c.studio.get(c.demo.aiRepId))?.draft;
  const persona = resolveBrandProfile(c.brand, setupAnswersOf(draft)).persona;

  // Identity: honor the invite link's hcpId only when it resolves to a real cohort member.
  const hcpId = typeof body.hcpId === "string" && c.targeting.has(body.hcpId) ? asId<"hcp_id">(body.hcpId) : c.demo.hcpId;
  // Each video call is its own reviewable session, so its transcript is exactly
  // that call (not pooled into the shared demo session). The recording attaches
  // to it via the recording_ready webhook (keyed by the Tavus conversation id).
  const hist = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
  // Mark this as the active call so /api/tavus/llm logs the authoritative transcript here (with
  // slideIds), and log the opening greeting once server-side (Tavus speaks it directly, not via
  // the LLM endpoint, so the endpoint never sees it).
  setActiveTavusSession(hist.id);
  if (persona.customGreeting) await c.sessions.appendTurn(hist.id, { speaker: "rep", text: persona.customGreeting });

  const startArgs = {
      record: true,
      callbackUrl: `${env.publicBaseUrl}/api/tavus/webhook`,
      sessionId: hist.id,
      personaCacheKey: c.brand.brandId, // one Tavus persona per brand, reused across sessions
      systemPrompt: persona.systemPrompt,
      customGreeting: persona.customGreeting,
      context: persona.context,
      customLlm: {
        baseUrl: `${env.publicBaseUrl}/api/tavus/llm`,
        apiKey: env.tavusLlmKey || undefined,
        model: "nexusrep-compliance",
      },
      replicaId: env.tavusReplicaId || undefined,
      hotwords: persona.hotwords,
      language: persona.language,
      tools: [],
      // Routing (off-label→MSL, AE→PV) is handled inside our custom-LLM endpoint, so
      // no inline persona tools are needed. External tool-calling would use Tavus's
      // /v2/tools registry. No external_voice_id — the replica uses its default voice.
    };

  let session;
  try {
    session = await provider.startSession(startArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Self-heal the concurrent-conversation cap: previews that closed without ending (a
    // tab shut mid-call, a process restart) leave live conversations that pile up to
    // Tavus's limit. End the stale ones and retry ONCE before giving up.
    if (/maximum concurrent conversations/i.test(message)) {
      const ended = await provider.endActiveConversations();
      if (ended > 0) {
        try {
          session = await provider.startSession(startArgs);
        } catch (retryError) {
          return NextResponse.json({
            provider: provider.name, configured: false, conversationUrl: null, token: null, sessionId: hist.id,
            reachableLlm: !/localhost|127\.0\.0\.1/.test(env.publicBaseUrl),
            note: `Tavus could not start this conversation: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          });
        }
      }
    }
    if (!session) {
      return NextResponse.json({
        provider: provider.name, configured: false, conversationUrl: null, token: null, sessionId: hist.id,
        reachableLlm: !/localhost|127\.0\.0\.1/.test(env.publicBaseUrl),
        note: `Tavus could not start this conversation: ${message}`,
      });
    }
  }

  // Link the Tavus conversation id to our per-call session, so the recording_ready
  // callback attaches the playback URL to the same session the transcript lives in.
  if (session.transportUrl) {
    await c.sessions.setTavusConversation(hist.id, session.id);
  }

  // Tavus's servers call our custom-LLM endpoint to get each reply. Actively PROBE the
  // public URL instead of guessing from its shape — a dead tunnel (trycloudflare URLs die
  // with their process) previously reported reachable and the replica greeted then went
  // silent with no explanation.
  let reachableLlm = !/localhost|127\.0\.0\.1/.test(env.publicBaseUrl);
  if (reachableLlm) {
    try {
      const probe = await fetch(`${env.publicBaseUrl.replace(/\/$/, "")}/api/models`, { signal: AbortSignal.timeout(5000) });
      reachableLlm = probe.ok;
    } catch {
      reachableLlm = false;
    }
  }
  return NextResponse.json({
    provider: provider.name,
    configured: Boolean(session.transportUrl),
    conversationUrl: session.transportUrl ?? null,
    token: session.token ?? null,
    // Our reviewable session id (the client logs utterances here). The Tavus
    // conversation id is separate and lives on the session as tavusConversationId.
    sessionId: hist.id,
    reachableLlm,
    note: !session.transportUrl
      ? "Set TAVUS_API_KEY (and TAVUS_REPLICA_ID) to enable the live Tavus avatar; using the built-in 3D avatar meanwhile."
      : reachableLlm
        ? "Live Tavus replica — replies produced by our compliance endpoint."
        : "Replica renders and greets, but replies won't flow: the public URL isn't reachable (dead tunnel?). Restart the tunnel and update NEXUSREP_PUBLIC_URL.",
  });
}
