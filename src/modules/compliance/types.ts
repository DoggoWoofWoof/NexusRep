/**
 * Compliance domain types (brief §18; PDF §7). The agent is a controlled graph:
 * one combined classifier, a deterministic policy router, and a final gate that
 * approves or blocks the EXACT response before it is spoken.
 */

export type Intent =
  | "product_info"
  | "dosing"
  | "safety"
  | "administration"
  | "trial_data"
  | "access"
  | "human_request"
  | "off_label"
  | "adverse_event"
  | "comparative"
  | "other";

/** One optimized classification call returns every risk signal (latency-aware). */
export interface RiskClassification {
  intent: Intent;
  confidence: number;
  offLabelRisk: number;
  adverseEventRisk: number;
  medicalInfoRisk: number;
  promptInjectionRisk: number;
  comparativeClaimRisk: number;
  isiRequired: boolean;
}

/** Where the policy router sends a turn. */
export type PolicyRoute =
  | "approved_answer"
  | "off_label_refusal"
  | "adverse_event"
  | "medical_information"
  | "human_handoff"
  | "fallback";

export interface ComplianceDecision {
  decision: "approved" | "blocked";
  reasons: string[];
  /** Whether ISI must accompany this output. */
  isiRequired: boolean;
}
