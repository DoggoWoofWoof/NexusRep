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
import type { ApprovedAnswer, GroundedComposer } from "@modules/content";
import type { RiskClassification } from "@modules/compliance";
import type { ConversationSession, SessionService } from "@modules/sessions";
import type { RuleSteering } from "@modules/rules";
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
}

export type TurnOpts = {
  classify?: (text: string) => Promise<RiskClassification>;
  compose?: (question: string, blocks: ApprovedAnswer[]) => Promise<string>;
};

export class ConversationService {
  constructor(private readonly deps: ConversationDeps) {}

  async start(input: { aiRepId: AiRepId; hcpId: TurnContext["hcpId"]; startedAt?: string; seed?: string }): Promise<ConversationSession> {
    return this.deps.sessions.start(input);
  }

  /**
   * Run one turn. Logs both sides, folds compliance status, and — when the turn
   * escalates — enqueues a CRM event to the outbox (delivered asynchronously by
   * the swappable adapter, never inline in the conversation).
   */
  async turn(ctx: TurnContext, opts?: TurnOpts): Promise<{ output: TurnOutput; session: ConversationSession | null }> {
    await this.deps.sessions.appendTurn(ctx.sessionId, { speaker: "hcp", text: ctx.text });

    // Fold the rep's active coaching rules into runtime steering (default: none).
    const steering = this.deps.steeringFor ? await this.deps.steeringFor(ctx.hcpId) : undefined;
    const output = await this.deps.orchestrator.handleTurn(ctx, { ...opts, steering });

    await this.deps.sessions.appendTurn(ctx.sessionId, {
      speaker: "rep",
      text: output.responseText,
      sourceIds: output.sourceIds,
      detailAidSlideId: output.detailAidSlideId,
    });
    await this.deps.sessions.recordOutcome(ctx.sessionId, { route: output.route, decision: output.decision });

    if (output.followUpType) {
      const payload: CrmEventPayload = {
        eventType: `followup_${output.followUpType}`,
        brandId: this.deps.context.brandId,
        campaignId: this.deps.context.campaignId,
        sessionId: ctx.sessionId,
        // hcpNpi intentionally omitted here → outbox surfaces needs_mapping,
        // which is the real behaviour when CRM identity resolution is pending.
        followUpType: output.followUpType,
      };
      const entry = await this.deps.crm.enqueue(ctx.sessionId, payload, `${ctx.sessionId}_${output.route}`);
      await this.deps.audit.record(ctx.sessionId, "crm_event", { crmEventId: entry.id, status: entry.status });
    }

    const session = await this.deps.sessions.get(ctx.sessionId);
    return { output, session };
  }

  async end(sessionId: TurnContext["sessionId"], input?: { durationSeconds?: number; endedAt?: string }): Promise<ConversationSession | null> {
    return this.deps.sessions.end(sessionId, input);
  }
}
