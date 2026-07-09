/**
 * First-party presentation walkthrough endpoint. It advances the approved deck
 * using NexusRep content/RAG, runs the final compliance gate, logs the turn, and
 * returns the slide to show. Tavus can render this, but Tavus is not the skill.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { complianceGate, type PolicyRoute, type RiskClassification } from "@modules/compliance";
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
  if (action === "next") return "Next slide.";
  if (action === "previous") return "Previous slide.";
  if (action === "jump") return query?.trim() ? `Show me the ${query.trim()} slide.` : "Jump to the relevant slide.";
  return "Walk me through the approved deck.";
}

function normalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    currentSlideId?: unknown;
    query?: unknown;
    displayText?: unknown;
    sessionId?: unknown;
    newSession?: unknown;
    greeting?: unknown;
  };
  const action = parseAction(body.action);
  const query = typeof body.query === "string" ? body.query : undefined;
  const displayText = typeof body.displayText === "string" ? body.displayText.trim().slice(0, 500) : "";
  const currentSlideId = typeof body.currentSlideId === "string" ? body.currentSlideId : undefined;
  const greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";

  const c = await getContainer();
  const requested = typeof body.sessionId === "string" ? asId<"session_id">(body.sessionId) : undefined;
  let sessionId = c.demo.sessionId;
  if (requested && (await c.sessions.get(requested))) {
    sessionId = requested;
  } else if (body.newSession === true) {
    const fresh = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    sessionId = fresh.id;
    if (greeting) await c.sessions.appendTurn(sessionId, { speaker: "rep", text: greeting });
  } else if (!(await c.sessions.get(sessionId))) {
    await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, seed: "demo" });
  }

  const requestText = displayText || hcpText(action, query);
  await c.sessions.appendTurn(sessionId, { speaker: "hcp", text: requestText });

  const rules = (await c.studio.get(c.demo.aiRepId))?.rules ?? [];
  const guidance = presentationGuidance(rules, { hcpId: c.demo.hcpId });
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
  let classification = PRESENTATION_CLASSIFICATION;

  if (step) {
    route = "approved_answer";
    sourceIds = step.sourceIds.map(String);
    detailAidSlideId = step.detailAidSlideId ? String(step.detailAidSlideId) : undefined;
    const isi = await c.content.latestActiveSafetyStatement();
    const includesSafetyText = Boolean(isi && normalized(step.text).includes(normalized(isi.text)));
    classification = { ...PRESENTATION_CLASSIFICATION, isiRequired: includesSafetyText };
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
  c.metrics.record({ latencyMs: 0, route });

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
