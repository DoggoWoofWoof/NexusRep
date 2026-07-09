/**
 * Canonical ID types. Every cross-module reference uses these branded IDs so a
 * `brand_id` can never be passed where an `hcp_id` is expected (brief §16).
 *
 * Branding is compile-time only — at runtime these are plain strings.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type TenantId = Brand<string, "tenant_id">;
export type BrandId = Brand<string, "brand_id">;
export type CampaignId = Brand<string, "campaign_id">;
export type AiRepId = Brand<string, "ai_rep_id">;
export type PersonaId = Brand<string, "persona_id">;
export type ContentAssetId = Brand<string, "content_asset_id">;
export type ApprovedAnswerId = Brand<string, "approved_answer_id">;
export type ApprovedClaimId = Brand<string, "approved_claim_id">;
export type SafetyStatementId = Brand<string, "safety_statement_id">;
export type DetailAidSlideId = Brand<string, "detail_aid_slide_id">;
export type MlrApprovalId = Brand<string, "mlr_approval_id">;
export type HcpId = Brand<string, "hcp_id">;
export type TargetListId = Brand<string, "target_list_id">;
export type SessionId = Brand<string, "session_id">;
export type TurnId = Brand<string, "turn_id">;
export type RuleId = Brand<string, "rule_id">;
export type TrainingSessionId = Brand<string, "training_session_id">;
export type FollowUpTaskId = Brand<string, "follow_up_task_id">;
export type CrmEventId = Brand<string, "crm_event_id">;
export type AuditEventId = Brand<string, "audit_event_id">;
export type EscalationEventId = Brand<string, "escalation_event_id">;

/**
 * Mint a prefixed id. Deterministic-friendly: pass a `seed` in tests/mocks to
 * keep snapshots stable. Falls back to time+random only when no seed is given.
 */
export function newId<T extends string>(prefix: string, seed?: string): Brand<string, T> {
  const suffix = seed ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${suffix}` as Brand<string, T>;
}

/** Cast a raw string to a branded id at a trust boundary (e.g. parsing input). */
export function asId<T extends string>(raw: string): Brand<string, T> {
  return raw as Brand<string, T>;
}
