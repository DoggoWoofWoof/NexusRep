/**
 * Agent voice-preview endpoint (Studio · Agent gallery hover). Renders — once, ever — a short clip
 * of the agent speaking the intro script in ITS OWN voice via the realtime provider's preview
 * capability (Tavus video generation), and caches the ready URL GLOBALLY in a committed manifest
 * (public/agent-previews.json) keyed by agent+tone. A rendered clip is cloned from GitHub, so it is
 * never regenerated in any environment (clean or seeded, local or Render) and no credits are
 * re-spent. A render takes minutes, so the client plays the agent's stock-clip audio (the proper
 * fallback) — or the opt-in synthetic voice — until this returns status "ready". Vendor-neutral:
 * any provider implementing AgentPreviewStudio works.
 */

import { NextResponse } from "next/server";
import { getRealtimeProvider, hasAgentPreview, type AgentPreviewClip } from "@modules/vendors";
import { previewScript, previewVideoName, toneLabel } from "@lib/agent-preview";
import { getCachedPreview, putCachedPreview } from "@lib/agent-preview-cache";

export const dynamic = "force-dynamic";

const keyOf = (agentId: string, tone: string) => `${agentId}:${toneLabel(tone)}`;

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { agentId?: unknown; name?: unknown; tone?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : agentId;
    const tone = typeof body.tone === "string" ? body.tone : "professional";
    if (!agentId) return NextResponse.json({ status: "unavailable", error: "agentId required" });

    const key = keyOf(agentId, tone);
    // 1. Durable global cache — a clip rendered anywhere (committed to the repo) is reused here.
    const cachedUrl = await getCachedPreview(key);
    if (cachedUrl) return NextResponse.json({ status: "ready", url: cachedUrl } satisfies AgentPreviewClip);

    const provider = getRealtimeProvider();
    if (!hasAgentPreview(provider)) return NextResponse.json({ status: "unavailable" } satisfies AgentPreviewClip);

    // 2. Render (or reuse an in-flight render, matched by deterministic video name → no dup spend).
    const clip = await provider.ensurePreviewClip({
      agentId,
      script: previewScript(name, tone),
      videoName: previewVideoName(agentId, tone),
    });
    // 3. Persist a ready clip to the committed manifest so it's cloned from GitHub next time.
    if (clip.status === "ready" && clip.url) await putCachedPreview(key, clip.url);
    return NextResponse.json(clip);
  } catch (error) {
    return NextResponse.json({ status: "unavailable", error: error instanceof Error ? error.message : String(error) });
  }
}
