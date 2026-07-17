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
import { resolveSessionAndHcp } from "@lib/resolve-session";
import { classifyWith } from "@modules/compliance";
import { getComposer } from "@modules/content";
import { logServerActivity } from "@lib/activity-log";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; classifier?: unknown; sessionId?: unknown; newSession?: unknown; greeting?: unknown; hcpId?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
  const classifier = typeof body.classifier === "string" ? body.classifier : undefined;
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const c = await getContainer();
  // Session + identity resolution shared with every conversation-shaped route
  // (invite-link hcpId validated against the cohort; sessions keep their identity).
  const { sessionId, hcpId } = await resolveSessionAndHcp(c, body);
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
      hcpId,
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

  // Surface compliance-critical turns in the activity monitor. Routine approved answers stay out of
  // the feed (the client already logs the API call); AE / off-label / escalation / handoff are the
  // ones an operator wants flagged, with the follow-up they triggered.
  if (output.route !== "approved_answer") {
    const critical = output.route === "adverse_event" || output.route === "off_label_refusal";
    void logServerActivity({
      category: "compliance",
      action: `Routed: ${output.route.replace(/_/g, " ")}`,
      target: text.slice(0, 80),
      sessionId,
      severity: critical ? "warn" : "notice",
      metadata: { route: output.route, followUp: output.followUpType ?? null },
    });
  }

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
