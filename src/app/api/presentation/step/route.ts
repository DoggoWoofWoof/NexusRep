/**
 * First-party presentation walkthrough endpoint. It advances the approved deck
 * using NexusRep content/RAG, runs the final compliance gate, logs the turn, and
 * returns the slide to show. Tavus can render this, but Tavus is not the skill.
 */

import { NextResponse } from "next/server";
import { limited } from "@lib/rate-limit";
import { getContainer } from "@lib/container";
import { resolveSessionAndHcp } from "@lib/resolve-session";
import { complianceGate, type PolicyRoute, type RiskClassification, classify, route as policyRouteFor } from "@modules/compliance";
import { presentationGuidance } from "@modules/rules";
import type { PresentationAction } from "@modules/content";

export const dynamic = "force-dynamic";

const SAFE_FALLBACK =
  "I want to make sure I only share approved information. Let me connect you with someone who can help.";

const PRESENTATION_CLASSIFICATION: RiskClassification = {
  intent: "product_info",
  confidence: 0.95,
  offLabelRisk: 0,
  adverseEventRisk: 0,
  medicalInfoRisk: 0,
  promptInjectionRisk: 0,
  comparativeClaimRisk: 0,
  isiRequired: false,
};

function parseAction(v: unknown): PresentationAction {
  return v === "next" || v === "previous" || v === "jump" ? v : "start";
}

function hcpText(action: PresentationAction, query?: string): string {
  if (action === "next") return "Please continue to the next point.";
  if (action === "previous") return "Can we go back to the prior point?";
  if (action === "jump") return query?.trim() ? `Can you talk about ${query.trim()}?` : "Can you bring up the most relevant point?";
  return "Can you walk me through the approved information?";
}

function normalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function POST(req: Request): Promise<NextResponse> {
  const limit = limited(req, "presentation");
  if (limit) return limit;
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    currentSlideId?: unknown;
    query?: unknown;
    displayText?: unknown;
    sessionId?: unknown;
    newSession?: unknown;
    greeting?: unknown;
    hcpId?: unknown;
  };
  const action = parseAction(body.action);
  const query = typeof body.query === "string" ? body.query : undefined;
  const displayText = typeof body.displayText === "string" ? body.displayText.trim().slice(0, 500) : "";
  const currentSlideId = typeof body.currentSlideId === "string" ? body.currentSlideId : undefined;

  const c = await getContainer();
  // Shared session + invite-link identity resolution (same logic as conversation/turn).
  const { sessionId, hcpId } = await resolveSessionAndHcp(c, body);

  const requestText = displayText || hcpText(action, query);
  const t0 = Date.now();

  // The walkthrough must never bypass the policy router: user-supplied text (a typed
  // jump query or the display text) can carry an adverse-event mention or an off-label
  // ask even when the client treated it as a deck command. Synthetic action strings
  // stay on the zero-risk constant; anything the HCP actually typed is
  // classified, and risky turns leave the deck flow for the REAL pipeline (AE→PV,
  // off-label refusal→MSL, medical info, human handoff — with follow-ups and audit).
  const supplied = Boolean(displayText || (action === "jump" && query?.trim()));
  const risk = supplied ? classify(requestText) : PRESENTATION_CLASSIFICATION;
  const riskPolicy = policyRouteFor(risk);
  if (riskPolicy !== "approved_answer" && riskPolicy !== "fallback") {
    const { output } = await c.conversation.turn({
      sessionId,
      hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text: requestText,
    });
    c.metrics.record({ latencyMs: Date.now() - t0, route: output.route });
    return NextResponse.json({
      route: output.route,
      response: output.responseText,
      isiDelivered: output.isiAttached,
      detailAidSlideId: output.detailAidSlideId ?? null,
      sourceIds: (output.sourceIds ?? []).map(String),
      decision: "approved",
      reasons: [],
      sessionId,
      skill: "nexusrep_presentation",
      step: null,
    });
  }
  await c.sessions.appendTurn(sessionId, { speaker: "hcp", text: requestText });

  const rules = (await c.studio.get(c.demo.aiRepId))?.rules ?? [];
  const guidance = presentationGuidance(rules, { hcpId });
  const step = await c.presentation.step({
    action,
    currentSlideId,
    query,
    context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
    guidance,
  });

  let route: PolicyRoute = "fallback";
  let responseText = SAFE_FALLBACK;
  let sourceIds: string[] = [];
  let detailAidSlideId: string | undefined;
  let isiAttached = false;
  let requiredSafetyText: string | undefined;
  let classification = risk;

  if (step) {
    route = "approved_answer";
    sourceIds = step.sourceIds.map(String);
    detailAidSlideId = step.detailAidSlideId ? String(step.detailAidSlideId) : undefined;
    const isi = await c.content.latestActiveSafetyStatement();
    const includesSafetyText = Boolean(isi && normalized(step.text).includes(normalized(isi.text)));
    classification = { ...risk, isiRequired: includesSafetyText };
    requiredSafetyText = includesSafetyText ? isi?.text : undefined;
    isiAttached = includesSafetyText;
    responseText = step.text;
    await c.audit.record(sessionId, "retrieval", {
      skill: "presentation",
      accepted: sourceIds,
      rejected: [],
      slide: detailAidSlideId,
      step: { action: step.action, index: step.index, total: step.total },
    });
  }
  await c.audit.record(sessionId, "classification", { ...classification, skill: "presentation" });

  const decision = complianceGate({
    responseText,
    classification,
    sourceIds,
    isiAttached,
    requiredSafetyText,
    route,
  });
  await c.audit.record(sessionId, "compliance_decision", { ...decision, route, skill: "presentation" });

  const finalText = decision.decision === "approved" ? responseText : SAFE_FALLBACK;
  await c.sessions.appendTurn(sessionId, {
    speaker: "rep",
    text: finalText,
    sourceIds: decision.decision === "approved" ? sourceIds : [],
    ...(decision.decision === "approved" && detailAidSlideId ? { detailAidSlideId } : {}),
  });
  await c.sessions.recordOutcome(sessionId, { route, decision: decision.decision });
  await c.audit.record(sessionId, "response_output", { route, text: finalText, sourceIds, detailAid: detailAidSlideId, skill: "presentation" });
  c.metrics.record({ latencyMs: Date.now() - t0, route }); // real latency, not 0 (was skewing analytics)

  return NextResponse.json({
    route,
    response: finalText,
    isiDelivered: decision.decision === "approved" && isiAttached,
    detailAidSlideId: decision.decision === "approved" ? detailAidSlideId ?? null : null,
    sourceIds: decision.decision === "approved" ? sourceIds : [],
    decision: decision.decision,
    reasons: decision.reasons,
    sessionId,
    skill: "nexusrep_presentation",
    step: step ? { action: step.action, index: step.index, total: step.total, slideTitle: step.slideTitle ?? null } : null,
  });
}
