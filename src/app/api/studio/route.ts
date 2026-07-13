/**
 * Thin controller for the Studio Build/Train lifecycle. GET returns a UI-ready
 * snapshot (rep, readiness, setup sections, rules). POST applies one action and
 * returns the fresh snapshot. All logic lives in StudioService; this only shapes
 * canonical TrainingRules into the display shape the screen renders.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";
import { compactCoaching } from "@modules/content";
import type { StudioSnapshot } from "@modules/aiRepStudio";
import { partitionCoaching, type RuleScope, type RuleStatus, type TrainingRule } from "@modules/rules";
import type { SectionKey, SectionStatus } from "@modules/setupAssistant";
import type { RepState } from "@modules/aiRepStudio";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<TrainingRule["type"], string> = {
  persona_style: "Style rule",
  blocked_topic: "Blocked topic",
  conversation_ordering: "Conversation ordering",
  comparative_claim: "Comparative claim",
  hcp_pointer: "HCP pointer",
};
const STATUS_LABEL: Record<RuleStatus, string> = {
  active: "Active",
  draft: "Draft",
  needs_source: "Needs source",
  needs_mlr: "Needs review",
  rejected: "Rejected",
  blocked_by_compliance: "Blocked",
};
const TIER_OF: Record<RuleScope, string> = {
  global: "Global",
  campaign: "Global",
  persona: "Persona",
  hcp_segment: "HCP",
  hcp_specific: "HCP",
};

function toUiRule(r: TrainingRule, personaName: string) {
  const tier = TIER_OF[r.scope];
  const hcp = r.appliesToHcpId ? hcpNameOf(r.appliesToHcpId) : undefined;
  return {
    id: r.id as string,
    type: TYPE_LABEL[r.type],
    status: STATUS_LABEL[r.status],
    tier,
    text: r.instruction,
    note: r.origin === "coaching" && r.sourceFeedback ? `From coaching: “${r.sourceFeedback}”` : "",
    scope: tier === "Global" ? "All AI reps" : tier === "HCP" ? (hcp ?? "HCP") : personaName,
    source: r.origin === "guardrail" ? "guardrail" : "feedback",
    ...(hcp ? { hcp } : {}),
    ...(r.origin === "coaching" ? { from: "rehearsal" } : {}),
    ...(r.sourceMessage ? { sourceMessage: r.sourceMessage } : {}),
  };
}

function shape(snap: StudioSnapshot) {
  const personaName = snap.rep.persona.displayName;
  return {
    rep: { displayName: personaName, state: snap.rep.state, voiceStyle: snap.rep.persona.voiceStyle },
    readiness: snap.readiness,
    sections: snap.draft.sections,
    rules: snap.rules.map((r) => toUiRule(r, personaName)),
    // Real launch state (persisted) — the Launch screen derives per-doctor invite links from it.
    activation: snap.activation ?? null,
  };
}

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  const snap = await c.studio.get(c.demo.aiRepId);
  return NextResponse.json(snap ? shape(snap) : null);
}

const UI_SCOPE: Record<string, RuleScope> = { persona: "persona", global: "global", hcp: "hcp_specific" };

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    questionKey?: string;
    value?: string;
    section?: SectionKey;
    status?: string;
    feedback?: string;
    scope?: string; // "persona" | "global" | "hcp"
    appliesToHcpId?: string;
    topic?: string;
    sourceMessage?: string;
    ruleId?: string;
    repState?: RepState;
    // acceptCoaching: the whole coaching thread for one answer.
    coachings?: unknown;
    question?: string;
    answer?: string;
    // launch: the activation list of cohort HCP ids to invite.
    hcpIds?: unknown;
  };
  const c = await getContainer();
  const id = c.demo.aiRepId;
  const done = (snap: StudioSnapshot | null) => NextResponse.json(snap ? shape(snap) : null);

  switch (body.action) {
    case "answer": {
      if (!body.questionKey || typeof body.value !== "string") return bad("questionKey and value required");
      const snap = await c.studio.answer(id, body.questionKey, body.value);
      // Targeting edits take effect NOW — re-query the cohort with the resolved brand
      // (fire-and-forget; the Audience screen reads the fresh cohort on next load).
      if (body.questionKey === "target_specialties" || body.questionKey === "diagnosis_codes") {
        void c.audienceRuntime.reloadForBrandChange().catch((e: unknown) => console.warn("[audience] reload after targeting edit failed:", e instanceof Error ? e.message : e));
      }
      return done(snap);
    }
    case "section":
      if (!body.section || !body.status) return bad("section and status required");
      return done(await c.studio.setSectionStatus(id, body.section, body.status as SectionStatus));
    case "rule": {
      if (!body.feedback) return bad("feedback required");
      const scope = body.scope ? UI_SCOPE[body.scope] : undefined;
      // An HCP binding only makes sense on hcp_specific rules — a stray id on a global/persona
      // rule would silently narrow it. Ignore it for other scopes.
      const appliesToHcpId = scope === "hcp_specific" ? body.appliesToHcpId ?? c.demo.hcpId : undefined;
      return done(await c.studio.addRule(id, { feedback: body.feedback, scope, appliesToHcpId, topic: body.topic, sourceMessage: body.sourceMessage }));
    }
    case "acceptCoaching": {
      // Persist a whole accepted coaching thread: compliance-sensitive notes → individual gated
      // rules; style notes → ONE compacted rule (LLM-summarized, with the accepted answer as an
      // example). Nothing here bypasses the compliance-aware rule status.
      const coachings = Array.isArray(body.coachings)
        ? body.coachings.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
        : [];
      if (coachings.length === 0) return done(await c.studio.get(id)); // nothing to persist
      const scope = body.scope ? UI_SCOPE[body.scope] : undefined;
      // An HCP binding only makes sense on hcp_specific rules — a stray id on a global/persona
      // rule would silently narrow it. Ignore it for other scopes.
      const appliesToHcpId = scope === "hcp_specific" ? body.appliesToHcpId ?? c.demo.hcpId : undefined;
      const { sensitive, style } = partitionCoaching(coachings);
      const compacted = style.length ? (await compactCoaching(style, { question: body.question ?? "", answer: body.answer ?? "" })).instruction : undefined;
      return done(await c.studio.acceptCoaching(id, { sensitive, style, compactedInstruction: compacted, scope, appliesToHcpId, sourceMessage: body.question }));
    }
    case "launch": {
      // Persist the REAL activation list (validated against the claims cohort) so the Launch
      // screen's state + per-doctor invite links survive navigation and restarts.
      const hcpIds = Array.isArray(body.hcpIds)
        ? body.hcpIds.filter((x): x is string => typeof x === "string" && c.targeting.has(x))
        : [];
      if (!hcpIds.length) return bad("hcpIds (valid cohort members) required");
      const isiGap = await missingIsi(c);
      if (isiGap) return bad(isiGap);
      return done(await c.studio.launch(id, hcpIds));
    }
    case "greeting": {
      // Accepting a coached OPENING LINE persists it as the rep's greeting + disclosure, so the
      // change is real everywhere the greeting is read (HCP view, Tavus persona) — not just local.
      if (typeof body.value !== "string" || !body.value.trim()) return bad("value required");
      await c.studio.answer(id, "greeting", body.value.trim());
      return done(await c.studio.answer(id, "disclosure", body.value.trim()));
    }
    case "ruleStatus":
      if (!body.ruleId || !body.status) return bad("ruleId and status required");
      return done(await c.studio.setRuleStatus(id, body.ruleId, body.status as RuleStatus));
    case "repState": {
      const allowed = ["draft", "in_review", "ready", "live"] as const;
      if (!allowed.includes(body.repState as never)) return bad(`repState must be one of ${allowed.join(", ")}`);
      if (body.repState === "live") {
        const isiGap = await missingIsi(c);
        if (isiGap) return bad(isiGap);
      }
      return done(await c.studio.setRepState(id, body.repState as (typeof allowed)[number]));
    }
    default:
      return bad("unknown action");
  }
}

/**
 * Compliance fail-safe: a rep cannot go LIVE without an approved Important Safety Information
 * statement — ISI must be delivered verbatim when required, so launching without one is blocked.
 * If the uploaded documents didn't contain an ISI, this is where the gap surfaces: the brand user
 * must add/confirm the ISI (Build → Approved knowledge → ISI) before launch. Returns an error
 * message to show, or null when an active ISI exists.
 */
async function missingIsi(c: Awaited<ReturnType<typeof getContainer>>): Promise<string | null> {
  const isi = await c.content.latestActiveSafetyStatement();
  return isi
    ? null
    : "An approved Important Safety Information (ISI) statement is required before the rep can go live. Your documents didn't include one — add or confirm the ISI in Build → Approved knowledge, then launch.";
}

function bad(msg: string): NextResponse {
  return NextResponse.json({ error: msg }, { status: 400 });
}
