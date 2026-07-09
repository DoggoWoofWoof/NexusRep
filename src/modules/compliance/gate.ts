/**
 * Policy router + final compliance gate (brief §18; PDF §6–7, §11).
 *
 * - The router maps a classification to exactly one path.
 * - The gate is the LAST check before output. It approves or BLOCKS the exact
 *   response. It fails safe: any uncertainty → block/escalate, never speak.
 */

import type { ComplianceDecision, PolicyRoute, RiskClassification } from "./types";

const HIGH = 0.6;

/** Deterministic policy routing. Safety-critical paths take precedence. */
export function route(c: RiskClassification): PolicyRoute {
  if (c.adverseEventRisk >= HIGH) return "adverse_event";
  if (c.offLabelRisk >= HIGH) return "off_label_refusal";
  // Comparative claims and deep medical questions go to a human/MSL unless an
  // approved comparative answer exists (checked by the orchestrator downstream).
  if (c.comparativeClaimRisk >= HIGH) return "medical_information";
  if (c.intent === "human_request") return "human_handoff";
  if (c.medicalInfoRisk >= HIGH) return "medical_information";
  if (c.intent === "other" || c.confidence < 0.6) return "fallback";
  return "approved_answer";
}

export interface GateInput {
  /** The exact text about to be spoken/displayed. */
  responseText: string;
  classification: RiskClassification;
  /** Canonical approved-answer IDs this response was composed from. Empty = ungrounded. */
  sourceIds: string[];
  /** Whether the required ISI text is actually attached to this output. */
  isiAttached: boolean;
  /** Verbatim ISI text expected in the final output when required. */
  requiredSafetyText?: string;
  route: PolicyRoute;
}

function normalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function containsVerbatimSafety(responseText: string, requiredSafetyText?: string): boolean {
  const required = normalized(requiredSafetyText ?? "");
  if (!required) return true;
  return normalized(responseText).includes(required);
}

/**
 * Final compliance gate. No response is spoken unless it is backed by approved
 * content and clears every check (PDF §11 "non-negotiable").
 */
export function complianceGate(input: GateInput): ComplianceDecision {
  const reasons: string[] = [];
  const { classification: c } = input;

  // Prompt-injection attempts never reach output.
  if (c.promptInjectionRisk >= HIGH) reasons.push("prompt_injection_detected");

  // Approved-answer responses must be grounded in at least one validated source.
  if (input.route === "approved_answer" && input.sourceIds.length === 0) {
    reasons.push("ungrounded_response");
  }

  // ISI must be delivered verbatim when required — but only on an actual approved
  // answer. A refusal / MSL-routing / AE / human-handoff turn speaks no approved
  // content, so ISI does not apply (and must not block the safe routing message).
  if (c.isiRequired && input.route === "approved_answer") {
    if (!input.isiAttached || !containsVerbatimSafety(input.responseText, input.requiredSafetyText)) {
      reasons.push("isi_missing");
    }
  }

  // Off-label / AE content must never be delivered as an approved answer.
  if (input.route === "approved_answer" && c.offLabelRisk >= HIGH) reasons.push("off_label_in_answer");
  if (input.route === "approved_answer" && c.adverseEventRisk >= HIGH) reasons.push("adverse_event_in_answer");

  // Empty output is never approved.
  if (!input.responseText.trim()) reasons.push("empty_response");

  return {
    decision: reasons.length === 0 ? "approved" : "blocked",
    reasons,
    isiRequired: c.isiRequired,
  };
}
