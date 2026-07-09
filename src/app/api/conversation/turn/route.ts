/**
 * Thin controller. NO business logic here — parses input, calls the orchestrator
 * (the controlled agent graph), and shapes the response. An optional `classifier`
 * lets the chat pick which LLM provider classifies this turn (for in-chat model
 * testing); it falls back to keyword if unavailable. Returns provider + latency
 * so the chat can badge the response.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { classifyWith } from "@modules/compliance";
import { getComposer } from "@modules/content";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; classifier?: unknown; sessionId?: unknown; newSession?: unknown; greeting?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const classifier = typeof body.classifier === "string" ? body.classifier : undefined;
  const greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const c = await getContainer();
  // Session selection: (1) an existing session the client named; (2) a fresh
  // per-conversation session when the client asks (newSession — the /hcp chat does
  // this on its first message so each chat is its own reviewable transcript); else
  // (3) the shared demo session, opened lazily.
  const requested = typeof body.sessionId === "string" ? asId<"session_id">(body.sessionId) : undefined;
  let sessionId: typeof c.demo.sessionId;
  if (requested && (await c.sessions.get(requested))) {
    sessionId = requested;
  } else if (body.newSession === true) {
    const fresh = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    sessionId = fresh.id;
    // Log the rep's opening greeting as turn 0 so it's in the transcript (not just
    // the live caption). Video sessions get it from the replica utterance instead.
    if (greeting) await c.sessions.appendTurn(sessionId, { speaker: "rep", text: greeting });
  } else {
    sessionId = c.demo.sessionId;
    if (!(await c.sessions.get(sessionId))) {
      await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, seed: "demo" });
    }
  }
  // Per-request model override (from the in-chat selector): route classification
  // AND answer composition through the chosen provider; fall back to defaults.
  const composer = classifier ? getComposer(classifier) : undefined;
  const opts =
    classifier
      ? {
          classify: (t: string) => classifyWith(classifier, t),
          // Let the chosen provider compose too (the orchestrator adds slide/steering guidance).
          ...(composer?.available() ? { composer } : {}),
        }
      : undefined;
  const t0 = Date.now();
  const { output } = await c.conversation.turn(
    {
      sessionId,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text,
    },
    opts,
  );
  const latencyMs = Date.now() - t0;
  c.metrics.record({ latencyMs, route: output.route });

  let detailAid: { title: string; label: string } | null = null;
  if (output.detailAidSlideId) {
    const slide = await c.content.getSlide(asId(output.detailAidSlideId));
    if (slide) detailAid = { title: slide.title, label: slide.label };
  }

  return NextResponse.json({
    route: output.route,
    response: output.responseText,
    isiDelivered: output.isiAttached,
    followUp: output.followUpType ?? null,
    detailAid,
    detailAidSlideId: output.detailAidSlideId ?? null,
    sessionId,
    provider: classifier ?? "default",
    latencyMs,
  });
}
