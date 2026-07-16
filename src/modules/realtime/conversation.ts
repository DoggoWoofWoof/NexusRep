/**
 * ConversationService — app-level composition of one HCP turn end-to-end
 * (brief §18 runtime turn). It keeps the TurnOrchestrator focused on the
 * compliance graph, and layers on the durable side-effects the demo/product
 * need: session turn logging, running compliance status, and the CRM outbox
 * hand-off on escalation.
 *
 *   hcp turn logged → orchestrator (classify→route→retrieve→gate) → rep turn
 *     logged → session status folded → CRM event enqueued on escalation
 *
 * Everything here goes through module public surfaces; no vendor SDK types leak.
 */

import type { AiRepId, BrandId, CampaignId } from "@lib/ids";
import type { AuditService } from "@modules/audit";
import type { CrmOutbox } from "@modules/crm";
import type { CrmEventPayload } from "@modules/vendors";
import type { GroundedComposer } from "@modules/content";
import type { RiskClassification } from "@modules/compliance";
import type { ConversationSession, SessionService } from "@modules/sessions";
import type { RuleSteering } from "@modules/rules";
import { canonicalizeProductNames } from "@modules/compliance";
import { TurnOrchestrator, type TurnContext, type TurnOutput } from "./orchestrator";

export interface ConversationDeps {
  orchestrator: TurnOrchestrator;
  sessions: SessionService;
  crm: CrmOutbox;
  audit: AuditService;
  /** Canonical brand/campaign for CRM events (never a raw vendor payload). */
  context: { brandId: BrandId; campaignId: CampaignId };
  /** Optional: the rep's ACTIVE-rule steering for an HCP (coaching → live behavior). */
  steeringFor?: (hcpId: string) => Promise<RuleSteering>;
  /** Optional: resolve an HCP's NPI (from the claims cohort) for CRM identity resolution.
   *  Unresolvable → the outbox surfaces "needs_mapping", the true unresolved-identity state. */
  npiFor?: (hcpId: string) => string | undefined;
}

export type TurnOpts = {
  classify?: (text: string) => Promise<RiskClassification>;
  /** Per-turn composer override (the in-chat "Test models" selector); null forces deterministic. */
  composer?: GroundedComposer | null;
  /** The caller already persisted the HCP utterance at the true input time (typed video path). */
  reuseLatestHcpTurn?: boolean;
  /** Optional realtime budgets; timeout falls back to deterministic safe behavior. */
  classificationTimeoutMs?: number;
  composerTimeoutMs?: number;
  composerMaxTokens?: number;
  /** Live voice can overlap a low-risk grounded draft with classification; final gate still decides. */
  speculativeCompose?: boolean;
  /** Tavus/mic voice path: keep full compliance, but skip slow composer repair passes. */
  liveVoice?: boolean;
  /** Optional style/length notes for this transport; still subordinate to grounding + gate. */
  coaching?: string[];
  /** Live voice should avoid optional "next slide" offers that lengthen speech and queue audio. */
  suppressRelatedSlide?: boolean;
};

function sameTurnText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(a) === norm(b)) return true;
  const tokens = (s: string) =>
    norm(s)
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const aw = tokens(a);
  const bw = tokens(b);
  if (!aw.length || !bw.length) return false;
  const bset = new Set(bw);
  const rawOverlap = aw.filter((w) => bset.has(w)).length / Math.max(aw.length, bw.length);
  if (rawOverlap >= 0.82) return true;

  // Tavus can normalize a typed prompt before it calls the custom LLM (for example
  // dropping "is" or "the"). Reuse only near-identical content turns, not a new
  // question that merely shares generic words like "what/how".
  const stop = new Set(["a", "an", "and", "are", "about", "can", "could", "do", "does", "for", "how", "i", "is", "it", "me", "of", "on", "or", "please", "should", "tell", "the", "to", "what", "would", "you"]);
  const ac = aw.filter((w) => !stop.has(w));
  const bc = bw.filter((w) => !stop.has(w));
  if (Math.max(ac.length, bc.length) < 2) return false;
  const bcset = new Set(bc);
  const contentOverlap = ac.filter((w) => bcset.has(w)).length / Math.max(ac.length, bc.length);
  return contentOverlap >= 0.9;
}

export class ConversationService {
  constructor(private readonly deps: ConversationDeps) {}

  async start(input: { aiRepId: AiRepId; hcpId: TurnContext["hcpId"]; startedAt?: string; seed?: string; preview?: boolean }): Promise<ConversationSession> {
    return this.deps.sessions.start(input);
  }

  /**
   * Run one turn. Logs both sides, folds compliance status, and — when the turn
   * escalates — enqueues a CRM event to the outbox (delivered asynchronously by
   * the swappable adapter, never inline in the conversation).
   */
  async turn(ctx: TurnContext, opts?: TurnOpts): Promise<{ output: TurnOutput; session: ConversationSession | null }> {
    // Recover a mistranscribed/typo'd product name ("no vexian" → "Milvexian") BEFORE the
    // turn is logged, classified, or retrieved — so a garbled name is answered, not bounced.
    const text = canonicalizeProductNames(ctx.text);
    const turnCtx = text === ctx.text ? ctx : { ...ctx, text };
    const existing = opts?.reuseLatestHcpTurn ? await this.deps.sessions.get(turnCtx.sessionId) : null;
    const latest = existing?.turns[existing.turns.length - 1];
    const alreadyLogged =
      latest?.speaker === "hcp" &&
      sameTurnText(latest.text, turnCtx.text);
    if (!alreadyLogged) {
      await this.deps.sessions.appendTurn(turnCtx.sessionId, { speaker: "hcp", text: turnCtx.text });
    }

    // Fold the rep's active coaching rules into runtime steering (default: none).
    const steering = this.deps.steeringFor ? await this.deps.steeringFor(turnCtx.hcpId) : undefined;
    const output = await this.deps.orchestrator.handleTurn(turnCtx, { ...opts, steering });

    await this.deps.sessions.appendTurn(turnCtx.sessionId, {
      speaker: "rep",
      text: output.responseText,
      sourceIds: output.sourceIds,
      detailAidSlideId: output.detailAidSlideId,
    });
    await this.deps.sessions.recordOutcome(turnCtx.sessionId, { route: output.route, decision: output.decision });

    if (output.followUpType) {
      // Resolve CRM identity from the claims cohort when available. No NPI → the outbox
      // truthfully reports "needs_mapping" instead of pretending delivery succeeded.
      const hcpNpi = this.deps.npiFor?.(turnCtx.hcpId);
      const payload: CrmEventPayload = {
        eventType: `followup_${output.followUpType}`,
        brandId: this.deps.context.brandId,
        campaignId: this.deps.context.campaignId,
        sessionId: ctx.sessionId,
        followUpType: output.followUpType,
        ...(hcpNpi ? { hcpNpi } : {}),
      };
      const entry = await this.deps.crm.enqueue(ctx.sessionId, payload, `${ctx.sessionId}_${output.route}`);
      // Attempt delivery immediately (the outbox worker for live events). Best-effort:
      // a delivery failure keeps the entry retryable via flush(), never breaks the turn.
      const delivered = await this.deps.crm.deliver(entry.id).catch(() => null);
      await this.deps.audit.record(ctx.sessionId, "crm_event", { crmEventId: entry.id, status: delivered?.status ?? entry.status });
    }

    const session = await this.deps.sessions.get(ctx.sessionId);
    return { output, session };
  }

  async end(sessionId: TurnContext["sessionId"], input?: { durationSeconds?: number; endedAt?: string }): Promise<ConversationSession | null> {
    return this.deps.sessions.end(sessionId, input);
  }
}
