/**
 * Video-agent gallery API (Studio · Agent mode). GET lists the browsable agents
 * (the account's own + the vendor's stock library) plus the current selection;
 * POST selects one (persisted on the studio state — every subsequent video call
 * uses it) or starts training a personal agent from footage.
 *
 * Vendor-neutral thin controller: catalog access lives on whichever provider
 * implements AgentCatalog, persistence on StudioService. Swapping the realtime
 * vendor changes NOTHING here. Always returns JSON — never an HTML error page.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { env } from "@lib/env";
import { getRealtimeProvider, hasAgentCatalog, type AgentSummary } from "@modules/vendors";

export const dynamic = "force-dynamic";

interface Payload {
  configured: boolean;
  /** Currently-selected agent id (studio override), or null = deployment default. */
  selected: string | null;
  selectedName: string | null;
  /** Persisted synthetic-voice override (an OpenAI voice id) — the agent's PERMANENT voice when
   *  set; null = use the agent's own/replica voice. */
  voiceId: string | null;
  defaultReplicaId: string | null;
  agents: AgentSummary[];
  note?: string;
  error?: string;
}

async function buildPayload(): Promise<Payload> {
  const c = await getContainer();
  const provider = getRealtimeProvider();
  const configured = hasAgentCatalog(provider);
  const snap = await c.studio.get(c.demo.aiRepId);
  const selected = snap?.appearance?.agentId || null;
  const selectedName = snap?.appearance?.agentName ?? null;
  const voiceId = snap?.appearance?.voiceId ?? null;
  let agents: AgentSummary[] = [];
  let note: string | undefined;
  if (hasAgentCatalog(provider)) {
    try {
      agents = await provider.listAgents();
    } catch (e) {
      note = `Couldn't load the agent gallery: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    note = "Live video agents aren't connected on this deployment — the built-in 3D avatar represents the rep meanwhile.";
  }
  return { configured, selected, selectedName, voiceId, defaultReplicaId: env.tavusReplicaId || null, agents, note };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await buildPayload());
  } catch (error) {
    return NextResponse.json({
      configured: false, selected: null, selectedName: null, voiceId: null, defaultReplicaId: null, agents: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown; agentId?: unknown; name?: unknown; trainVideoUrl?: unknown; voiceId?: unknown;
    };
    const c = await getContainer();
    const provider = getRealtimeProvider();

    if (body.action === "select") {
      // null clears the override (back to the deployment default agent).
      const agentId = body.agentId === null ? null : typeof body.agentId === "string" ? body.agentId.trim() : "";
      if (agentId === "") return NextResponse.json({ ...(await buildPayload()), error: "agentId required (or null to clear)" });
      let name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
      if (agentId !== null && hasAgentCatalog(provider)) {
        // Validate against the live catalog — a typo'd/foreign id would fail every call later.
        const match = (await provider.listAgents()).find((r) => r.id === agentId);
        if (!match) return NextResponse.json({ ...(await buildPayload()), error: "That agent isn't in your gallery." });
        if (match.status !== "ready") return NextResponse.json({ ...(await buildPayload()), error: "That agent is still training — pick a ready one." });
        name = match.name;
      }
      await c.studio.setAppearance(c.demo.aiRepId, { agentId, agentName: agentId === null ? null : name || null });
      return NextResponse.json(await buildPayload());
    }

    if (body.action === "create") {
      if (!hasAgentCatalog(provider)) return NextResponse.json({ ...(await buildPayload()), error: "Live video agents aren't connected on this deployment." });
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      const trainVideoUrl = typeof body.trainVideoUrl === "string" ? body.trainVideoUrl.trim() : "";
      if (name.length < 2) return NextResponse.json({ ...(await buildPayload()), error: "Give the agent a name (2+ characters)." });
      if (!/^https:\/\/.+/.test(trainVideoUrl)) return NextResponse.json({ ...(await buildPayload()), error: "The training footage must be an https:// video URL." });
      const created = await provider.createAgent({ name, trainVideoUrl });
      const payload = await buildPayload();
      // The vendor list can lag right after creation — make sure the new agent shows up.
      if (!payload.agents.some((r) => r.id === created.id)) payload.agents = [created, ...payload.agents];
      return NextResponse.json({ ...payload, note: "Training started — this takes a few hours. The agent appears here as “Training” until it's ready." });
    }

    if (body.action === "voice") {
      // Persist (or clear) the synthetic-voice override. When set it becomes the agent's permanent
      // voice (off-video TTS + previews); null reverts to the agent's own/replica voice.
      const voiceId = body.voiceId === null ? null : typeof body.voiceId === "string" ? body.voiceId.trim() || null : null;
      await c.studio.setAppearance(c.demo.aiRepId, { voiceId });
      return NextResponse.json(await buildPayload());
    }

    return NextResponse.json({ ...(await buildPayload()), error: "Unknown action." });
  } catch (error) {
    return NextResponse.json({
      configured: false, selected: null, selectedName: null, voiceId: null, defaultReplicaId: null, agents: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
