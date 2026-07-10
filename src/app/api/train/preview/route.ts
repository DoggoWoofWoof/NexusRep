/**
 * Thin controller for the Training coaching loop. Given a question and the coaching
 * notes gathered so far, it re-answers AS THE REP — classify → route → retrieve →
 * LLM-compose (with the coaching as guidance) → ground → compliance gate → detail-aid —
 * exactly like a live turn, but with NO side effects: no session, no logged turns, no
 * follow-up / CRM work (`preview: true`). Rehearsal until the brand user is satisfied.
 *
 * Coaching is style/emphasis guidance only; it is layered UNDER the composer's absolute
 * grounding rules and the deterministic gate still runs, so coaching can never make the
 * rep say anything unapproved.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { complianceGate, isiAlreadyDelivered, type PolicyRoute, type RiskClassification } from "@modules/compliance";
import { composeGreeting, firstAvailableComposer, mergePlan, PresentationSkill } from "@modules/content";
import { isOverviewPrompt } from "@modules/content/overviewPrompt";
import { presentationGuidance, rehearsalStyleGuidance } from "@modules/rules";

export const dynamic = "force-dynamic";

// A fixed, non-listed session id for rehearsal audit records. SessionService never creates
// it, so it never appears in Sessions — only the audit store sees it (harmless).
const PREVIEW_SESSION = asId<"session_id">("session_train_preview");
const SAFE_FALLBACK =
  "I want to make sure I only share approved information. Let me connect you with someone who can help.";

const PREVIEW_PRESENTATION_CLASSIFICATION: RiskClassification = {
  intent: "product_info",
  confidence: 0.95,
  offLabelRisk: 0,
  adverseEventRisk: 0,
  medicalInfoRisk: 0,
  promptInjectionRisk: 0,
  comparativeClaimRisk: 0,
  isiRequired: false,
};

/** A coached greeting is only usable if it KEEPS the mandatory disclosures (fail safe otherwise). */
function greetingHasDisclosures(text: string, investigational: boolean): boolean {
  const t = text.toLowerCase();
  const ai = /\bai\b|artificial intelligence|automated|virtual (?:rep|assistant)/.test(t);
  const medInfo = /medical information|medical team|medical affairs|medical inquir/.test(t);
  const inv = !investigational || /investigational|not (?:yet )?(?:fda[- ]?)?approved|under (?:study|investigation)|not approved/.test(t);
  return text.trim().length > 0 && ai && medInfo && inv;
}

function normalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function previewSessionId(v: unknown) {
  if (typeof v !== "string") return PREVIEW_SESSION;
  const clean = v.trim();
  return /^session_train_preview_[a-z0-9_-]{4,80}$/i.test(clean) ? asId<"session_id">(clean) : PREVIEW_SESSION;
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; coaching?: unknown; kind?: unknown; current?: unknown; previewSessionId?: unknown };
  // Cap note count + length: coaching is guidance text folded into an LLM prompt, so it is
  // bounded to keep the prompt sane (and shrink the injection surface).
  const coaching = Array.isArray(body.coaching)
    ? body.coaching
        .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
        .slice(0, 12)
        .map((g) => g.trim().slice(0, 300))
    : [];

  const c = await getContainer();

  // Coaching the OPENING GREETING — a free rewrite (not a grounded answer) that must keep the
  // mandatory disclosures. If the rewrite drops one, we keep the current greeting (fail safe).
  if (body.kind === "greeting") {
    const current = typeof body.current === "string" && body.current.trim() ? body.current.trim() : c.brand.greeting;
    const { text: rewritten, usedLlm } = await composeGreeting({ current, coaching, investigational: c.demo.investigational });
    const ok = greetingHasDisclosures(rewritten, c.demo.investigational);
    return NextResponse.json({
      response: ok ? rewritten : current,
      route: "greeting",
      isiDelivered: false,
      detailAidSlideId: null,
      usedLlm: ok && usedLlm,
      coachingApplied: coaching.length,
      // true → the rewrite dropped a required disclosure, so we kept the compliant greeting.
      greetingKept: coaching.length > 0 && !ok,
    });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const sessionId = previewSessionId(body.previewSessionId);
  const studioSnap = await c.studio.get(c.demo.aiRepId);
  const rules = studioSnap?.rules ?? [];

  if (body.kind === "overview" || isOverviewPrompt(text, c.brand.lexicon)) {
    const savedDeckGuidance = presentationGuidance(rules, { hcpId: c.demo.hcpId, rehearsal: true });
    const guidance = Array.from(new Set([...savedDeckGuidance, ...coaching].map((g) => g.trim()).filter(Boolean)));
    const presentation = new PresentationSkill(c.content);
    const ctx = { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market };
    // ALWAYS speak from the effective plan (saved ?? DocNexus default) — the same plan the
    // Brand-pitch card displays. Rehearsal must never follow a different order than the card.
    const plan = mergePlan(studioSnap?.guidedOverview, await presentation.defaultPlan(ctx), await presentation.deck(ctx));
    const steps = await presentation.overview({ context: ctx, guidance, plan });
    const isi = await c.content.latestActiveSafetyStatement();
    const priorAudit = isi ? await c.audit.forSession(sessionId) : [];
    let isiDelivered = Boolean(isi && isiAlreadyDelivered(priorAudit, isi.text));
    const route: PolicyRoute = steps.length ? "approved_answer" : "fallback";
    const responses: string[] = [];
    // Per-step segments so the Train rehearsal can render the overview paragraph-by-paragraph with
    // each step's own slide — matching the doctor-facing delivery — instead of one joined block.
    const segments: { response: string; detailAidSlideId: string | null; slideTitle: string | null; stepId: string | null; stepTitle: string | null }[] = [];
    let firstSlide: string | null = null;
    let attachedThisRun = false;

    for (const [index, step] of steps.entries()) {
      const sourceIds = step.sourceIds.map(String);
      const detailAidSlideId = step.detailAidSlideId ? String(step.detailAidSlideId) : undefined;
      if (!firstSlide && detailAidSlideId) firstSlide = detailAidSlideId;
      const includesSafetyText = Boolean(isi && normalized(step.text).includes(normalized(isi.text)));
      const shouldAppendSafety = Boolean(isi && !isiDelivered && !includesSafetyText && index === steps.length - 1);
      const shouldRequireSafety = Boolean(isi && (includesSafetyText || shouldAppendSafety));
      const classification = { ...PREVIEW_PRESENTATION_CLASSIFICATION, isiRequired: shouldRequireSafety };
      let responseText = shouldAppendSafety && isi ? `${step.text}\n\nImportant Safety Information: ${isi.text}` : step.text;
      const decision = complianceGate({
        responseText,
        classification,
        sourceIds,
        isiAttached: shouldRequireSafety,
        requiredSafetyText: shouldRequireSafety ? isi?.text : undefined,
        route,
      });
      responseText = decision.decision === "approved" ? responseText : SAFE_FALLBACK;
      if (decision.decision === "approved" && shouldRequireSafety) {
        isiDelivered = true;
        attachedThisRun = attachedThisRun || shouldAppendSafety;
      }
      await c.audit.record(sessionId, "response_output", {
        route,
        text: responseText,
        sourceIds: decision.decision === "approved" ? sourceIds : [],
        detailAid: decision.decision === "approved" ? detailAidSlideId : undefined,
        skill: "presentation_preview",
        segment: index + 1,
      });
      responses.push(responseText);
      segments.push({
        response: responseText,
        detailAidSlideId: decision.decision === "approved" ? detailAidSlideId ?? null : null,
        slideTitle: step.slideTitle ?? null,
        stepId: step.stepId ?? null,
        stepTitle: step.stepTitle ?? null,
      });
    }

    const response = responses.length ? responses.join("\n\n") : SAFE_FALLBACK;
    return NextResponse.json({
      response,
      segments,
      route,
      isiDelivered: attachedThisRun,
      detailAid: null,
      detailAidSlideId: firstSlide,
      usedLlm: true,
      coachingApplied: coaching.length,
      savedStyleRulesApplied: savedDeckGuidance.length,
      skill: "nexusrep_presentation_overview",
    });
  }

  // Rehearsal always uses the LLM (if a key is configured) so coaching can restyle the
  // wording — even when the live rep runs the deterministic builder. If no LLM is
  // configured, we fall back to approved-text-only and tell the UI (usedLlm:false).
  // Force the LLM composer for rehearsal (so coaching can restyle wording even when the live rep
  // runs the deterministic builder), passing the coaching in as guidance. null → no key → the
  // orchestrator uses approved text only, and we report usedLlm:false.
  const composer = firstAvailableComposer();
  const savedGuidance = rehearsalStyleGuidance(rules, { hcpId: c.demo.hcpId });
  const guidance = Array.from(new Set([...savedGuidance, ...coaching].map((g) => g.trim()).filter(Boolean)));
  const opts = { preview: true as const, composer, coaching: guidance };

  const output = await c.orchestrator.handleTurn(
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

  let detailAid: { title: string; label: string } | null = null;
  if (output.detailAidSlideId) {
    const slide = await c.content.getSlide(asId(output.detailAidSlideId));
    if (slide) detailAid = { title: slide.title, label: slide.label };
  }

  return NextResponse.json({
    response: output.responseText,
    route: output.route,
    isiDelivered: output.isiAttached,
    detailAid,
    detailAidSlideId: output.detailAidSlideId ?? null,
    // Did coaching actually get applied by an LLM? (false → no AI key: approved text only,
    // so wording won't restyle — the UI surfaces this so the demo stays honest.)
    usedLlm: Boolean(composer),
    coachingApplied: coaching.length,
    savedStyleRulesApplied: savedGuidance.length,
  });
}
