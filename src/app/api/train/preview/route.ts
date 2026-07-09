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
import { composeGreeting, getComposer, type GroundedComposer } from "@modules/content";
import { rehearsalStyleGuidance } from "@modules/rules";

export const dynamic = "force-dynamic";

// A fixed, non-listed session id for rehearsal audit records. SessionService never creates
// it, so it never appears in Sessions — only the audit store sees it (harmless).
const PREVIEW_SESSION = asId<"session_id">("session_train_preview");

/** The first configured LLM composer (needed to actually restyle wording from coaching). */
function firstAvailableComposer(): GroundedComposer | null {
  for (const name of ["claude", "openai", "thinking-machines"]) {
    const c = getComposer(name);
    if (c?.available()) return c;
  }
  return null;
}

/** A coached greeting is only usable if it KEEPS the mandatory disclosures (fail safe otherwise). */
function greetingHasDisclosures(text: string, investigational: boolean): boolean {
  const t = text.toLowerCase();
  const ai = /\bai\b|artificial intelligence|automated|virtual (?:rep|assistant)/.test(t);
  const medInfo = /medical information|medical team|medical affairs|medical inquir/.test(t);
  const inv = !investigational || /investigational|not (?:yet )?(?:fda[- ]?)?approved|under (?:study|investigation)|not approved/.test(t);
  return text.trim().length > 0 && ai && medInfo && inv;
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; coaching?: unknown; kind?: unknown; current?: unknown };
  const coaching = Array.isArray(body.coaching)
    ? body.coaching.filter((g): g is string => typeof g === "string" && g.trim().length > 0).map((g) => g.trim())
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
  // Rehearsal always uses the LLM (if a key is configured) so coaching can restyle the
  // wording — even when the live rep runs the deterministic builder. If no LLM is
  // configured, we fall back to approved-text-only and tell the UI (usedLlm:false).
  // Force the LLM composer for rehearsal (so coaching can restyle wording even when the live rep
  // runs the deterministic builder), passing the coaching in as guidance. null → no key → the
  // orchestrator uses approved text only, and we report usedLlm:false.
  const composer = firstAvailableComposer();
  const savedGuidance = rehearsalStyleGuidance((await c.studio.get(c.demo.aiRepId))?.rules ?? [], { hcpId: c.demo.hcpId });
  const guidance = Array.from(new Set([...savedGuidance, ...coaching].map((g) => g.trim()).filter(Boolean)));
  const opts = { preview: true as const, composer, coaching: guidance };

  const output = await c.orchestrator.handleTurn(
    {
      sessionId: PREVIEW_SESSION,
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
