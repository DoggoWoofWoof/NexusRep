/**
 * Agent voice-preview endpoint (Studio · Agent gallery hover). By default this is DISABLED
 * (env.agentPreviewRender off) and returns "unavailable" — the client then plays the agent's
 * STOCK Tavus clip (real voice, no cost). When enabled, it renders — once, ever — a clip of the
 * agent speaking our (tone-free) script via Tavus video generation and caches the ready URL
 * GLOBALLY in a committed manifest (public/agent-previews.json), keyed by agent id. A rendered
 * clip is cloned from GitHub, so it's never regenerated in any environment and no credits are
 * re-spent. Vendor-neutral: any provider implementing AgentPreviewStudio works.
 */

import { NextResponse } from "next/server";
import { env } from "@lib/env";
import { getRealtimeProvider, hasAgentPreview, type AgentPreviewClip } from "@modules/vendors";
import { previewScript, previewVideoName } from "@lib/agent-preview";
import { getCachedPreview, putCachedPreview } from "@lib/agent-preview-cache";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { agentId?: unknown; name?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : agentId;
    if (!agentId) return NextResponse.json({ status: "unavailable", error: "agentId required" });

    // 1. Durable global cache — a clip rendered anywhere (committed to the repo) is reused, even
    //    if rendering is now disabled (the cached clip already exists).
    const cachedUrl = await getCachedPreview(agentId);
    if (cachedUrl) return NextResponse.json({ status: "ready", url: cachedUrl } satisfies AgentPreviewClip);

    // 2. Rendering is opt-in. Off by default → the client falls back to the stock clip.
    if (!env.agentPreviewRender) return NextResponse.json({ status: "unavailable" } satisfies AgentPreviewClip);

    const provider = getRealtimeProvider();
    if (!hasAgentPreview(provider)) return NextResponse.json({ status: "unavailable" } satisfies AgentPreviewClip);

    // 3. Render (or reuse an in-flight render, matched by deterministic video name → no dup spend).
    const clip = await provider.ensurePreviewClip({
      agentId,
      script: previewScript(name),
      videoName: previewVideoName(agentId),
    });
    if (clip.status === "ready" && clip.url) await putCachedPreview(agentId, clip.url);
    return NextResponse.json(clip);
  } catch (error) {
    return NextResponse.json({ status: "unavailable", error: error instanceof Error ? error.message : String(error) });
  }
}
