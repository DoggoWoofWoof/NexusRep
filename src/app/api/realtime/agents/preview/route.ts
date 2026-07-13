/**
 * Agent voice-preview endpoint (Studio · Agent gallery hover). Renders — once — a short clip of
 * the agent speaking the intro script in ITS OWN voice via the realtime provider's preview
 * capability (Tavus video generation), and caches the ready URL per (agent, tone). A render takes
 * minutes, so the client plays the agent's stock-clip audio (or the opt-in synthetic voice) until
 * this returns status "ready". Vendor-neutral: any provider implementing AgentPreviewStudio works.
 */

import { NextResponse } from "next/server";
import { getRealtimeProvider, hasAgentPreview, type AgentPreviewClip } from "@modules/vendors";
import { previewScript, previewVideoName, toneLabel } from "@lib/agent-preview";

export const dynamic = "force-dynamic";

// Process-wide cache of preview outcomes, keyed by agent+tone. A "ready" URL is served forever;
// a "generating" entry is re-checked against the provider each request until it flips to ready.
const previewCache = new Map<string, AgentPreviewClip>();
const keyOf = (agentId: string, tone: string) => `${agentId}:${toneLabel(tone)}`;

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { agentId?: unknown; name?: unknown; tone?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : agentId;
    const tone = typeof body.tone === "string" ? body.tone : "professional";
    if (!agentId) return NextResponse.json({ status: "unavailable", error: "agentId required" });

    const key = keyOf(agentId, tone);
    const cached = previewCache.get(key);
    if (cached?.status === "ready") return NextResponse.json(cached);

    const provider = getRealtimeProvider();
    if (!hasAgentPreview(provider)) return NextResponse.json({ status: "unavailable" } satisfies AgentPreviewClip);

    const clip = await provider.ensurePreviewClip({
      agentId,
      script: previewScript(name, tone),
      videoName: previewVideoName(agentId, tone),
    });
    // Cache ready/unavailable terminally; keep re-checking a still-rendering clip on the next hover.
    if (clip.status !== "generating") previewCache.set(key, clip);
    return NextResponse.json(clip);
  } catch (error) {
    return NextResponse.json({ status: "unavailable", error: error instanceof Error ? error.message : String(error) });
  }
}
