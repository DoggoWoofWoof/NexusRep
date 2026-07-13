/**
 * Single source of demo history for the Milvexian tenant (investigational Factor
 * XIa inhibitor · cardiology · US LIBREXIA campaign). Seeds the real services —
 * SessionService,
 * FollowUpService, CrmOutbox — so the brand console's Sessions / Analytics /
 * Audience / Follow-ups surfaces render from live, computed state rather than
 * hardcoded arrays. All HCP features are claims-derived AGGREGATES (no PHI).
 */

import { asId, type AiRepId, type BrandId, type CampaignId, type HcpId, type SessionId } from "@lib/ids";
import { MILVEXIAN_COHORT } from "@modules/audience";
import type { SessionService } from "@modules/sessions";
import type { FollowUpService, FollowUpType } from "@modules/followups";
import type { CrmOutbox } from "@modules/crm";
import type { AuditService } from "@modules/audit";
import { classify } from "@modules/compliance";
import type { StudioService } from "@modules/aiRepStudio";
import type { AIRepPersona } from "@modules/aiRepStudio";
import type { BrandProfile } from "@modules/brand";
import { asId as asPersonaId } from "@lib/ids";

const h = (id: string) => asId<"hcp_id">(id) as HcpId;

/** Resolve an HCP id to a display name (the cardiology cohort is the directory). */
export function hcpNameOf(id: string): string {
  return MILVEXIAN_COHORT.find((f) => f.id === id)?.name ?? id;
}

interface SeedSession {
  sid: string;
  hcpId: HcpId;
  startedAt: string;
  durationSeconds: number;
  questionCount: number;
  status: "approved" | "needs_review" | "ae_routed" | "blocked_escalated";
  follow?: FollowUpType;
  /** Provide an NPI so the CRM outbox resolves to "sent"; omit → "needs_mapping". */
  hcpNpi?: string;
}

const SEED_SESSIONS: SeedSession[] = [
  { sid: "session_sx4471", hcpId: h("hcp_sharma"), startedAt: "2026-07-06T09:42:00.000Z", durationSeconds: 468, questionCount: 4, status: "approved", follow: "msl", hcpNpi: "1013" },
  { sid: "session_sx4468", hcpId: h("hcp_okafor"), startedAt: "2026-07-05T14:05:00.000Z", durationSeconds: 730, questionCount: 6, status: "approved", follow: "human_rep", hcpNpi: "1024" },
  { sid: "session_sx4465", hcpId: h("hcp_castellano"), startedAt: "2026-07-05T11:20:00.000Z", durationSeconds: 390, questionCount: 3, status: "needs_review", follow: "medical_information" },
  { sid: "session_sx4462", hcpId: h("hcp_nguyen"), startedAt: "2026-07-04T16:48:00.000Z", durationSeconds: 332, questionCount: 3, status: "ae_routed", follow: "pharmacovigilance", hcpNpi: "1042" },
  { sid: "session_sx4459", hcpId: h("hcp_andersson"), startedAt: "2026-07-04T10:15:00.000Z", durationSeconds: 134, questionCount: 1, status: "blocked_escalated", follow: "msl" },
  { sid: "session_sx4455", hcpId: h("hcp_haddad"), startedAt: "2026-07-03T13:30:00.000Z", durationSeconds: 545, questionCount: 5, status: "approved", follow: "human_rep", hcpNpi: "1055" },
];

export interface SeedDeps {
  sessions: SessionService;
  followups: FollowUpService;
  crm: CrmOutbox;
  audit: AuditService;
  aiRepId: AiRepId;
  brandId: BrandId;
  campaignId: CampaignId;
}

/** The demo conversations, as the questions doctors actually asked. Each is classified by
 *  the REAL classifier at seed time, so the Overview "what HCPs are asking" mix and the
 *  compliance rates are measured from the audit trail — not a hand-typed bar chart. */
const SEED_QUESTIONS: { session: string; q: string; grounded?: string; route?: string }[] = [
  { session: "session_sx4471", q: "What is it and how does it work?", grounded: "ans_moa" },
  { session: "session_sx4471", q: "What's the program?", grounded: "ans_program" },
  { session: "session_sx4455", q: "What is Milvexian and how does it work?", grounded: "ans_moa" },
  { session: "session_sx4455", q: "Tell me about the LIBREXIA program", grounded: "ans_program" },
  { session: "session_sx4455", q: "What's the development and FDA status?", grounded: "ans_program" },
  { session: "session_sx4455", q: "What are the side effects?" },
  { session: "session_sx4455", q: "Is it better than apixaban?", route: "medical_information" },
  { session: "session_sx4459", q: "Can I use it for pediatric patients?", route: "off_label_refusal" },
];

/** Seed the real stores with demo history. Idempotent-friendly (deterministic ids). */
export async function seedDemoHistory(deps: SeedDeps): Promise<void> {
  for (const s of SEED_SESSIONS) {
    const sessionId = asId<"session_id">(s.sid) as SessionId;
    await deps.sessions.seed({
      id: sessionId,
      aiRepId: deps.aiRepId,
      hcpId: s.hcpId,
      startedAt: s.startedAt,
      durationSeconds: s.durationSeconds,
      questionCount: s.questionCount,
      complianceStatus: s.status,
      turns: [],
      ...(s.sid === "session_sx4471" ? { vendorConversationId: "seed_call_sx4471", recordingUrl: "/recordings/seeded-session-sx4471.webm" } : {}),
    });

    if (s.follow) {
      await deps.followups.create({
        hcpId: s.hcpId,
        type: s.follow,
        sourceSessionId: sessionId,
        seed: `${s.sid}_fu`,
      });
      const entry = await deps.crm.enqueue(
        sessionId,
        {
          eventType: `followup_${s.follow}`,
          brandId: deps.brandId,
          campaignId: deps.campaignId,
          sessionId,
          followUpType: s.follow,
          ...(s.hcpNpi ? { hcpNpi: s.hcpNpi } : {}),
        },
        `${s.sid}_crm`,
      );
      // Attempt delivery so the outbox shows a real terminal status (sent / needs_mapping).
      await deps.crm.deliver(entry.id);
    }
  }

  // Give the first session a real, reviewable transcript (both sides + the slide the rep
  // showed) so Session Review renders evidence — not an empty shell. Deterministic ids/times.
  const first = asId<"session_id">("session_sx4471") as SessionId;
  const t = (n: number) => `2026-07-06T09:42:${String(n).padStart(2, "0")}.000Z`;
  await deps.sessions.appendTurn(first, { speaker: "rep", text: "Hello, doctor. I'm an AI representative — I share only publicly-available information and route clinical questions to Medical Information.", seed: "sx4471_t0", at: t(0) });
  await deps.sessions.appendTurn(first, { speaker: "hcp", text: "What is it and how does it work?", seed: "sx4471_t1", at: t(8) });
  await deps.sessions.appendTurn(first, { speaker: "rep", text: "Here's what I can share on that: it is an investigational, orally administered Factor XIa (FXIa) inhibitor being studied as an anticoagulant. It is not approved by the FDA or any regulatory authority.\n\nImportant Safety Information: this is an investigational compound; its safety and efficacy have not been established.", sourceIds: ["ans_moa"], detailAidSlideId: "slide_moa", seed: "sx4471_t2", at: t(11) });
  await deps.sessions.appendTurn(first, { speaker: "hcp", text: "What's the program?", seed: "sx4471_t3", at: t(30) });
  await deps.sessions.appendTurn(first, { speaker: "rep", text: "Good question. It is being evaluated in the Phase 3 LIBREXIA program across three indications under study.", sourceIds: ["ans_program"], detailAidSlideId: "slide_program", seed: "sx4471_t4", at: t(33) });

  // Record REAL audit events for the seeded conversations (idempotent) so the Overview
  // question mix + compliance rates are measured from the classifier/gate, not hand-typed.
  const alreadySeeded = (await deps.audit.allOfType("classification")).length > 0;
  if (!alreadySeeded) {
    for (let i = 0; i < SEED_QUESTIONS.length; i++) {
      const { session, q, grounded, route } = SEED_QUESTIONS[i]!;
      const sid = asId<"session_id">(session) as SessionId;
      const cls = classify(q);
      const decisionRoute = route ?? "approved_answer";
      await deps.audit.record(sid, "classification", { ...cls }, undefined, `seedcls_${i}`);
      await deps.audit.record(
        sid,
        "compliance_decision",
        { decision: "approved", reasons: [], route: decisionRoute, isiRequired: cls.isiRequired },
        undefined,
        `seeddec_${i}`,
      );
      await deps.audit.record(
        sid,
        "response_output",
        { route: decisionRoute, sourceIds: grounded ? [grounded] : [] },
        undefined,
        `seedout_${i}`,
      );
    }
  }
}

/**
 * Seed a launch-ready Milvexian rep in the Studio so Build/Train render from
 * persisted state and Launch is enabled. Uses the real setup-answer + rule
 * pipeline — nothing here bypasses the compliance-aware rule status.
 */
/**
 * A "clean slate" studio: just a DRAFT rep so the console renders (not a null snapshot), with
 * no setup answers, guardrails, coaching rules, approved-content sign-off, or live state. The
 * user builds it from scratch via the Setup Assistant. Used for the "clean" demo accounts.
 */
export async function seedDraftStudio(deps: { studio: StudioService; aiRepId: AiRepId; brandId: BrandId; campaignId: CampaignId; brand: BrandProfile }): Promise<void> {
  const b = deps.brand;
  const persona: AIRepPersona = {
    id: asPersonaId<"persona_id">(`persona_${b.brandId}`),
    type: "brand_persona",
    displayName: b.displayName, // generic for a clean/blank brand (e.g. "Your AI Rep") — user renames it
    voiceStyle: "professional",
    disclosureText: b.greeting,
    greeting: b.greeting,
  };
  await deps.studio.getOrCreate({ aiRepId: deps.aiRepId, brandId: deps.brandId, campaignId: deps.campaignId, persona });
}

export async function seedDemoStudio(deps: { studio: StudioService; aiRepId: AiRepId; brandId: BrandId; campaignId: CampaignId; brand: BrandProfile }): Promise<void> {
  // Everything brand-specific comes from the active BrandProfile — swap the profile and
  // the seeded rep re-themes itself. Nothing here is hardcoded to Milvexian.
  const b = deps.brand;
  const persona: AIRepPersona = {
    id: asPersonaId<"persona_id">(`persona_${b.brandId}`),
    type: "brand_persona",
    displayName: `${b.displayName} Medical AI Specialist`,
    voiceStyle: "clinical",
    disclosureText: b.greeting,
    greeting: b.greeting,
  };
  await deps.studio.getOrCreate({ aiRepId: deps.aiRepId, brandId: deps.brandId, campaignId: deps.campaignId, persona });

  // Seed the setup answers with the profile's CLEAN values so the resolve-from-chat merge
  // is a no-op for the demo (identical rep); any later user edit in chat/UI then takes effect.
  const a = (k: string, v: string) => deps.studio.answer(deps.aiRepId, k, v);
  await a("brand", b.displayName);
  await a("therapeutic_area", b.campaign.subtitle);
  await a("indication", b.clinical.indication);
  await a("persona_type", "Brand persona");
  await a("target_audience", b.clinical.audience);
  await a("approved_content", "Approved public program materials");
  await a("disclosure", persona.disclosureText);
  await a("greeting", persona.greeting);
  await a("talking_points", b.talkingPoints.join(", "));
  await a("msl_contact", "Medical Information / MSL desk + human handoff");
  await a("ae_routing", "Pharmacovigilance safety desk");

  // MLR / Medical sign-off for the linked public content (the gated step).
  await deps.studio.setSectionStatus(deps.aiRepId, "approved_knowledge", "complete");

  // Locked compliance guardrails (always active, cannot be trained away).
  await deps.studio.addGuardrail(deps.aiRepId, { type: "persona_style", scope: "global", instruction: "Deliver the investigational disclosure once per conversation (greeting or first product answer) — do not repeat it on every reply.", seed: "grd_isi" });
  await deps.studio.addGuardrail(deps.aiRepId, { type: "blocked_topic", scope: "global", instruction: "Refuse off-label or pediatric questions and route to Medical Information.", seed: "grd_offlabel" });
  await deps.studio.addGuardrail(deps.aiRepId, { type: "persona_style", scope: "persona", instruction: "Open every session with the AI + investigational disclosure before sharing information.", seed: "grd_disclosure" });

  // A couple of training rules from coaching feedback (compliance-aware status).
  await deps.studio.addRule(deps.aiRepId, { feedback: "Keep answers concise unless the HCP asks for detail.", seed: "rule_style" });
  await deps.studio.addRule(deps.aiRepId, {
    feedback: "When this doctor asks about the program, lead with the publicly-disclosed program indications.",
    appliesToHcpId: "hcp_sharma",
    scope: "hcp_specific",
    topic: "program",
    seed: "rule_sharma",
  });

  // Collapse any duplicate coaching rules accumulated in the durable store (e.g. from
  // repeated identical coaching across restarts) so the Rules screen stays clean.
  await deps.studio.dedupeRules(deps.aiRepId);

  // Rep is ready → go live (fails safe if readiness is incomplete).
  await deps.studio.setRepState(deps.aiRepId, "live");
}
