/**
 * Guided presentation endpoint. A normal vague HCP opener ("Can you give me the
 * overview?") becomes a rep-led, multi-slide presentation: one HCP turn, then
 * several approved rep segments with exact slide IDs. Tavus renders the avatar;
 * NexusRep owns the approved content, slide order, compliance gate, transcript,
 * and audit record.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { complianceGate, type PolicyRoute, type RiskClassification } from "@modules/compliance";

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

function normalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

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
  };
  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text.trim().slice(0, 500)
      : "Can you give me a high-level overview?";
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

  await c.sessions.appendTurn(sessionId, { speaker: "hcp", text });
  let nextRepAt = Date.now() + 350;

  const steps = await c.presentation.overview({
    context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
  });
  const isi = await c.content.latestActiveSafetyStatement();
  const route: PolicyRoute = steps.length ? "approved_answer" : "fallback";
  const segments = [];
  let overviewIsiDelivered = false;

  for (const [index, step] of steps.entries()) {
    const finalSegment = index === steps.length - 1;
    const includesSafetyText = Boolean(isi && normalized(step.text).includes(normalized(isi.text)));
    const shouldAppendSafety = Boolean(isi && !overviewIsiDelivered && !includesSafetyText && finalSegment);
    const shouldRequireSafety = Boolean(isi && (includesSafetyText || shouldAppendSafety));
    const classification = { ...BASE_CLASSIFICATION, isiRequired: shouldRequireSafety };
    await c.audit.record(sessionId, "classification", { ...classification, skill: "presentation_overview", segment: index + 1 });

    const sourceIds = step.sourceIds.map(String);
    const detailAidSlideId = step.detailAidSlideId ? String(step.detailAidSlideId) : undefined;
    let responseText = step.text;
    let isiAttached = false;
    let requiredSafetyText: string | undefined;
    if (includesSafetyText && isi) {
      requiredSafetyText = isi.text;
      isiAttached = true;
      overviewIsiDelivered = true;
    } else if (shouldAppendSafety && isi) {
      requiredSafetyText = isi.text;
      responseText = `${responseText}\n\nImportant Safety Information: ${isi.text}`;
      isiAttached = true;
      overviewIsiDelivered = true;
    }

    await c.audit.record(sessionId, "retrieval", {
      skill: "presentation_overview",
      accepted: sourceIds,
      rejected: [],
      slide: detailAidSlideId,
      step: { action: step.action, index: step.index, total: step.total },
    });

    const decision = complianceGate({
      responseText,
      classification,
      sourceIds,
      isiAttached,
      requiredSafetyText,
      route,
    });
    await c.audit.record(sessionId, "compliance_decision", { ...decision, route, skill: "presentation_overview", segment: index + 1 });

    const finalText = decision.decision === "approved" ? responseText : SAFE_FALLBACK;
    await c.sessions.appendTurn(sessionId, {
      speaker: "rep",
      text: finalText,
      sourceIds: decision.decision === "approved" ? sourceIds : [],
      ...(decision.decision === "approved" && detailAidSlideId ? { detailAidSlideId } : {}),
      at: new Date(nextRepAt).toISOString(),
    });
    nextRepAt += estimateSpeechMs(finalText) + 900;
    await c.sessions.recordOutcome(sessionId, { route, decision: decision.decision });
    await c.audit.record(sessionId, "response_output", {
      route,
      text: finalText,
      sourceIds,
      detailAid: detailAidSlideId,
      skill: "presentation_overview",
      segment: index + 1,
    });
    c.metrics.record({ latencyMs: 0, route });

    segments.push({
      route,
      response: finalText,
      isiDelivered: decision.decision === "approved" && isiAttached,
      detailAidSlideId: decision.decision === "approved" ? detailAidSlideId ?? null : null,
      sourceIds: decision.decision === "approved" ? sourceIds : [],
      decision: decision.decision,
      reasons: decision.reasons,
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
