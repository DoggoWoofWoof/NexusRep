/**
 * Policy router + final compliance gate (brief §18; PDF §6–7, §11).
 *
 * - The router maps a classification to exactly one path.
 * - The gate is the LAST check before output. It approves or BLOCKS the exact
 *   response. It fails safe: any uncertainty → block/escalate, never speak.
 */

import { env } from "@lib/env";
import type { ComplianceDecision, PolicyRoute, RiskClassification } from "./types";

// Risk threshold is deployment-configurable (NEXUSREP_RISK_THRESHOLD, default 0.6) —
// a stricter compliance policy can lower it without a code change.
const HIGH = env.riskThreshold;

/** Deterministic policy routing. Safety-critical paths take precedence. */
export function route(c: RiskClassification): PolicyRoute {
  if (c.adverseEventRisk >= HIGH) return "adverse_event";
  if (c.offLabelRisk >= HIGH) return "off_label_refusal";
  // Comparative claims and deep medical questions go to a human/MSL unless an
  // approved comparative answer exists (checked by the orchestrator downstream).
  if (c.comparativeClaimRisk >= HIGH) return "medical_information";
  if (c.intent === "human_request") return "human_handoff";
  // A deep-medical signal routes to Medical Information — UNLESS the message is a public product/
  // program question (intent product_info), which the rep should ANSWER from approved content. A
  // classifier sometimes over-flags medicalInfoRisk on questions like "what is the program
  // studying?" just because they sound clinical; grounding + the final gate still protect the
  // answer (no approved content → the orchestrator falls back safely), so it's safe to attempt.
  if (c.medicalInfoRisk >= HIGH && c.intent !== "product_info") return "medical_information";
  // Don't reflexively bounce an unclear or low-confidence question. ATTEMPT an approved answer:
  // the orchestrator retrieves approved content and returns the safe fallback ONLY when nothing
  // grounded matches. So the rep holds a natural conversation and answers whenever it can, while
  // the grounding gate + retrieval (not an eager intent guess) remain the real guardrails.
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

export interface PresentationSegmentGateInput {
  /** The approved segment text. */
  text: string;
  /** Canonical source ids backing the segment. */
  sourceIds: string[];
  /** The active ISI text, if any (undefined → no ISI to enforce). */
  isiText?: string;
  /** Has the ISI already been delivered earlier in THIS overview? (No re-delivery mid-walk.) */
  isiAlreadyDelivered: boolean;
  /** Is this the last segment? (ISI is appended on the final segment if not already shown.) */
  isLastSegment: boolean;
  route: PolicyRoute;
  /** The zero-risk presentation classification the caller starts from (isiRequired is set here). */
  baseClassification: RiskClassification;
  /** Text to speak instead when the gate blocks. */
  safeFallback: string;
}

export interface PresentationSegmentGateResult {
  /** Gated text to speak (the approved text, ISI appended when required, or the safe fallback). */
  finalText: string;
  approved: boolean;
  decision: ComplianceDecision;
  classification: RiskClassification;
  requiredSafetyText?: string;
  /** ISI was required for this segment (inline OR appended). */
  shouldRequireSafety: boolean;
  /** ISI was APPENDED to this segment (final-segment top-up) rather than already inline. */
  shouldAppendSafety: boolean;
  /** The segment text already contained the verbatim ISI. */
  includesSafetyText: boolean;
}

/**
 * The per-segment compliance core for a guided-overview walk — the exact ISI-append + final-gate
 * logic that the live overview and the training-preview routes each used to inline (identically).
 * Pure: it computes the ISI requirement, appends the verbatim ISI on the last segment when needed,
 * runs the final gate, and returns the gated text + flags. Callers own their OWN side effects (audit,
 * turn persistence, metrics) and their own running "ISI already delivered" bookkeeping — this only
 * owns the safety-critical decision so it can never drift between the two callers again.
 */
export function gatePresentationSegment(input: PresentationSegmentGateInput): PresentationSegmentGateResult {
  const { text, sourceIds, isiText, isiAlreadyDelivered, isLastSegment, route, baseClassification, safeFallback } = input;
  const includesSafetyText = Boolean(isiText && normalized(text).includes(normalized(isiText)));
  const shouldAppendSafety = Boolean(isiText && !isiAlreadyDelivered && !includesSafetyText && isLastSegment);
  const shouldRequireSafety = Boolean(isiText && (includesSafetyText || shouldAppendSafety));
  const classification: RiskClassification = { ...baseClassification, isiRequired: shouldRequireSafety };
  const requiredSafetyText = shouldRequireSafety ? isiText : undefined;
  const responseText = shouldAppendSafety && isiText ? `${text}\n\nImportant Safety Information: ${isiText}` : text;
  const decision = complianceGate({ responseText, classification, sourceIds, isiAttached: shouldRequireSafety, requiredSafetyText, route });
  const approved = decision.decision === "approved";
  return {
    finalText: approved ? responseText : safeFallback,
    approved,
    decision,
    classification,
    requiredSafetyText,
    shouldRequireSafety,
    shouldAppendSafety,
    includesSafetyText,
  };
}
