/**
 * Guided presentation endpoint. A normal vague HCP opener ("Can you give me the
 * overview?") becomes a rep-led, multi-slide presentation: one HCP turn, then
 * several approved rep segments with exact slide IDs. Tavus renders the avatar;
 * NexusRep owns the approved content, slide order, compliance gate, transcript,
 * and audit record.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { resolveSessionAndHcp } from "@lib/resolve-session";
import { gatePresentationSegment, isiAlreadyDelivered, type PolicyRoute, type RiskClassification, classify, route as policyRouteFor } from "@modules/compliance";
import { mergePlan, PresentationSkill, defaultComposer } from "@modules/content";
import { presentationGuidance } from "@modules/rules";

export const dynamic = "force-dynamic";

const SAFE_FALLBACK =
  "I want to make sure I only share approved information. Let me connect you with someone who can help.";

const BASE_CLASSIFICATION: RiskClassification = {
  intent: "product_info",
  confidence: 0.95,
  offLabelRisk: 0,
  adverseEventRisk: 0,
  medicalInfoRisk: 0,
  promptInjectionRisk: 0,
  comparativeClaimRisk: 0,
  isiRequired: false,
};

function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(5500, Math.min(28000, words * 360));
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    text?: unknown;
    sessionId?: unknown;
    newSession?: unknown;
    greeting?: unknown;
    hcpId?: unknown;
  };
  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text.trim().slice(0, 500)
      : "Can you give me a high-level overview?";

  const c = await getContainer();
  // Shared session + invite-link identity resolution (same logic as conversation/turn).
  const { sessionId, hcpId } = await resolveSessionAndHcp(c, body);

  // Same guard as the step route: an overview prompt is user-typed text and can carry
  // an AE mention or an off-label ask — classify it, and route risky turns through the
  // real pipeline instead of narrating the deck over them.
  const risk = classify(text);
  const riskPolicy = policyRouteFor(risk);
  if (riskPolicy !== "approved_answer" && riskPolicy !== "fallback") {
    const { output } = await c.conversation.turn({
      sessionId,
      hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text,
    });
    return NextResponse.json({
      sessionId,
      segments: [{ response: output.responseText, detailAidSlideId: output.detailAidSlideId ?? null, slideTitle: null, stepId: null, stepTitle: null }],
      skill: "nexusrep_presentation",
    });
  }
  await c.sessions.appendTurn(sessionId, { speaker: "hcp", text });
  let nextRepAt = Date.now() + 350;

  const snap = await c.studio.get(c.demo.aiRepId);
  const rules = snap?.rules ?? [];
  const guidance = presentationGuidance(rules, { hcpId });
  const presentation = new PresentationSkill(c.content, defaultComposer());
  const ctx = { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market };
  // Doctor delivery follows the SAME effective plan the Brand-pitch card shows — never a
  // silently reordered walk (what the brand user rehearsed is what the doctor hears).
  const plan = mergePlan(snap?.guidedOverview, await presentation.defaultPlan(ctx), await presentation.deck(ctx));
  const steps = await presentation.overview({ context: ctx, guidance, plan });
  const isi = await c.content.latestActiveSafetyStatement();
  const route: PolicyRoute = steps.length ? "approved_answer" : "fallback";
  const segments = [];
  const priorAudit = isi ? await c.audit.forSession(sessionId) : [];
  let overviewIsiDelivered = Boolean(isi && isiAlreadyDelivered(priorAudit, isi.text));

  for (const [index, step] of steps.entries()) {
    const segStart = Date.now();
    const sourceIds = step.sourceIds.map(String);
    const detailAidSlideId = step.detailAidSlideId ? String(step.detailAidSlideId) : undefined;
    // Shared per-segment ISI + compliance gate (identical to the training-preview route).
    const gated = gatePresentationSegment({
      text: step.text,
      sourceIds,
      isiText: isi?.text,
      isiAlreadyDelivered: overviewIsiDelivered,
      isLastSegment: index === steps.length - 1,
      route,
      baseClassification: BASE_CLASSIFICATION,
      safeFallback: SAFE_FALLBACK,
    });
    if (gated.shouldRequireSafety) overviewIsiDelivered = true;
    const approved = gated.approved;

    await c.audit.record(sessionId, "classification", { ...gated.classification, skill: "presentation_overview", segment: index + 1 });
    await c.audit.record(sessionId, "retrieval", {
      skill: "presentation_overview",
      accepted: sourceIds,
      rejected: [],
      slide: detailAidSlideId,
      step: { action: step.action, index: step.index, total: step.total },
    });
    await c.audit.record(sessionId, "compliance_decision", { ...gated.decision, route, skill: "presentation_overview", segment: index + 1 });

    await c.sessions.appendTurn(sessionId, {
      speaker: "rep",
      text: gated.finalText,
      sourceIds: approved ? sourceIds : [],
      ...(approved && detailAidSlideId ? { detailAidSlideId } : {}),
      at: new Date(nextRepAt).toISOString(),
    });
    nextRepAt += estimateSpeechMs(gated.finalText) + 900;
    await c.sessions.recordOutcome(sessionId, { route, decision: gated.decision.decision });
    await c.audit.record(sessionId, "response_output", {
      route,
      text: gated.finalText,
      sourceIds,
      detailAid: detailAidSlideId,
      skill: "presentation_overview",
      segment: index + 1,
    });
    c.metrics.record({ latencyMs: Date.now() - segStart, route }); // real per-segment latency, not 0

    segments.push({
      route,
      response: gated.finalText,
      isiDelivered: approved && gated.shouldRequireSafety,
      detailAidSlideId: approved ? detailAidSlideId ?? null : null,
      sourceIds: approved ? sourceIds : [],
      decision: gated.decision.decision,
      reasons: gated.decision.reasons,
      step: { action: step.action, index: step.index, total: step.total, slideTitle: step.slideTitle ?? null },
    });
  }

  if (!segments.length) {
    await c.sessions.appendTurn(sessionId, { speaker: "rep", text: SAFE_FALLBACK });
  }

  return NextResponse.json({
    route,
    sessionId,
    segments: segments.length
      ? segments
      : [{ route: "fallback", response: SAFE_FALLBACK, isiDelivered: false, detailAidSlideId: null, sourceIds: [], decision: "approved", reasons: [] }],
    skill: "nexusrep_presentation_overview",
  });
}
