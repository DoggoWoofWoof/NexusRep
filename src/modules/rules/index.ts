/**
 * Training rules (brief §6.4–6.7, §9). Coaching feedback becomes draft rules.
 * Every rule has a SCOPE and a STATUS. Rules that change medical/dosing/efficacy/
 * safety/comparative/promotional content require source validation + MLR before
 * they can become active — training feedback must never bypass compliance.
 */

import { newId, type RuleId } from "@lib/ids";

export type RuleScope = "global" | "campaign" | "persona" | "hcp_segment" | "hcp_specific";

export type RuleStatus =
  | "active"
  | "draft"
  | "needs_source"
  | "needs_mlr"
  | "rejected"
  | "blocked_by_compliance";

export type RuleType =
  | "persona_style"
  | "blocked_topic"
  | "conversation_ordering"
  | "comparative_claim"
  | "hcp_pointer";

export interface TrainingRule {
  id: RuleId;
  type: RuleType;
  scope: RuleScope;
  status: RuleStatus;
  instruction: string;
  /** Free-text origin: the coaching comment that produced this rule. */
  sourceFeedback: string;
  /** For hcp_specific/hcp_pointer rules. */
  appliesToHcpId?: string;
  topic?: string;
  /** Whether this is a locked compliance guardrail or a coaching-derived rule. */
  origin: "guardrail" | "coaching";
  /** The specific rep line the coach was commenting on (for referral/traceability). */
  sourceMessage?: string;
}

/** Feedback that touches these requires approved sources before going active. */
const COMPLIANCE_SENSITIVE: RuleType[] = ["blocked_topic", "comparative_claim", "conversation_ordering"];

export interface GenerateRuleInput {
  feedback: string;
  scope?: RuleScope;
  appliesToHcpId?: string;
  topic?: string;
  /** The specific rep line being coached (for referral/traceability). */
  sourceMessage?: string;
  /** Does an approved source already back the claim this rule implies? */
  hasApprovedSource?: boolean;
  seed?: string; // deterministic id for tests
}

/**
 * Convert a coaching comment into a draft rule with the correct type, scope, and
 * compliance-aware status. Pure + deterministic so it is unit-testable.
 */
export function generateRule(input: GenerateRuleInput): TrainingRule {
  const fb = input.feedback.toLowerCase();
  const { type, defaultScope, topic } = inferType(fb, input);

  const scope: RuleScope = input.scope ?? (input.appliesToHcpId ? "hcp_specific" : defaultScope);
  const status = inferStatus(type, input.hasApprovedSource ?? false);

  return {
    id: newId<"rule_id">("rule", input.seed) as RuleId,
    type,
    scope,
    status,
    instruction: instructionFor(type, input.feedback, topic),
    sourceFeedback: input.feedback,
    appliesToHcpId: input.appliesToHcpId,
    topic,
    origin: "coaching",
    sourceMessage: input.sourceMessage,
  };
}

/** Runtime steering derived from a rep's ACTIVE rules — consumed by the orchestrator. */
export interface RuleSteering {
  /** Topics an active blocked_topic rule forbids → route those questions to Medical Info. */
  blockedTopics: string[];
  /** Topics an active ordering/pointer rule wants the rep to lead with → bias retrieval. */
  leadTopics: string[];
  /**
   * Free-text tone/emphasis coaching from ACTIVE persona_style rules. Passed to the LLM composer
   * as guidance so accepted coaching actually shapes the live rep's wording (never overrides
   * grounding or the gate). Empty on the deterministic path (no composer to apply it).
   */
  styleGuidance: string[];
}

/**
 * Fold a rep's rules into runtime steering. ONLY active, compliance-cleared rules steer —
 * draft/needs_source/needs_mlr/blocked rules never do, so the compliance gate is never bypassed.
 * Topic-based steering (block/reorder) needs a concrete topic; style guidance does not. hcp_pointer
 * rules apply only for their HCP.
 */
export function activeSteering(rules: TrainingRule[], opts?: { hcpId?: string }): RuleSteering {
  const active = rules.filter((r) => r.status === "active");
  const withTopic = active.filter((r) => r.topic);
  const blockedTopics = withTopic.filter((r) => r.type === "blocked_topic").map((r) => r.topic!);
  const leadTopics = withTopic
    .filter((r) => r.type === "conversation_ordering" || (r.type === "hcp_pointer" && (!r.appliesToHcpId || r.appliesToHcpId === opts?.hcpId)))
    .map((r) => r.topic!);
  const styleGuidance = active.filter((r) => r.type === "persona_style").map((r) => r.instruction);
  return { blockedTopics, leadTopics, styleGuidance };
}

/**
 * Rehearsal preview is a safe sandbox: accepted style drafts should affect the next
 * coached preview immediately, while live HCP turns still use only active rules.
 */
export function rehearsalStyleGuidance(rules: TrainingRule[], opts?: { hcpId?: string }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.origin !== "coaching") continue;
    if (rule.type !== "persona_style") continue;
    if (rule.status !== "draft" && rule.status !== "active") continue;
    if (rule.appliesToHcpId && rule.appliesToHcpId !== opts?.hcpId) continue;
    const instruction = rule.instruction.trim();
    const key = instruction.toLowerCase();
    if (!instruction || seen.has(key)) continue;
    seen.add(key);
    out.push(instruction);
  }
  return out;
}

/**
 * Split coaching notes into compliance-SENSITIVE (blocked/comparative/ordering — each must stay
 * its own gated rule) vs STYLE (tone/emphasis — safe to compact into one rule). Used on accept so
 * "compact into one rule" never collapses a gated note into an ungated style rule.
 */
export function partitionCoaching(notes: string[]): { sensitive: string[]; style: string[] } {
  const sensitive: string[] = [];
  const style: string[] = [];
  for (const note of notes) {
    const t = generateRule({ feedback: note }).type;
    (COMPLIANCE_SENSITIVE.includes(t) ? sensitive : style).push(note);
  }
  return { sensitive, style };
}

function inferType(
  fb: string,
  input: GenerateRuleInput,
): { type: RuleType; defaultScope: RuleScope; topic?: string } {
  // Compliance-sensitive intents win first (they gate the rule's status).
  if (/safer than|better than|superior|competitor|comparative/.test(fb)) {
    return { type: "comparative_claim", defaultScope: "campaign" };
  }
  const blockedTrigger = /do not talk about|don'?t (?:mention|discuss|raise)|never (?:mention|raise|bring up)|avoid (?:mentioning|discussing|raising)?/;
  if (blockedTrigger.test(fb)) {
    // Capture WHAT to block so the rule is enforceable at runtime (not just advisory).
    return { type: "blocked_topic", defaultScope: "campaign", topic: input.topic ?? extractTopic(fb, blockedTrigger) };
  }
  const orderTrigger = /lead with|start with|open with|prioriti(?:ze|se)|earlier|first|before|order/;
  if (orderTrigger.test(fb)) {
    return { type: "conversation_ordering", defaultScope: "campaign", topic: input.topic ?? extractTopic(fb, /lead with|start with|open with|prioriti(?:ze|se)/) };
  }
  // An HCP-specific coaching note that isn't ordering/blocked is a targeted pointer.
  if (input.appliesToHcpId) {
    return { type: "hcp_pointer", defaultScope: "hcp_specific", topic: input.topic };
  }
  return { type: "persona_style", defaultScope: "persona" };
}

/**
 * Pull the salient topic out of a coaching phrase so the rule can be matched against
 * an HCP question at runtime — e.g. "don't mention pricing" → "pricing". Deliberately
 * coarse: strips the trigger phrase + common filler and keeps the rest. Runtime matching
 * (orchestrator) is per-word, so a noisy multi-word remainder still matches its key words.
 */
function extractTopic(fb: string, trigger: RegExp): string | undefined {
  const s = fb
    .toLowerCase()
    .replace(trigger, " ")
    .replace(/[.?!,]/g, " ")
    .replace(/\b(the|a|an|any|all|at all|about|our|your|please|when|asks?|for|with|it|this|that|topic|unless|approved|response|exists?|to|of|and|or|in|on|doctors?|hcps?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || undefined;
}

/** True when the feedback is a brevity/length instruction. */
function isBrevity(fb: string): boolean {
  return /shorter|briefly|concise|under \d+|less detail|keep .* short|keep .* brief/.test(fb);
}

function inferStatus(type: RuleType, hasApprovedSource: boolean): RuleStatus {
  if (!COMPLIANCE_SENSITIVE.includes(type)) return "draft";
  // Comparative claims with no approved source cannot become a live rule.
  if (type === "comparative_claim") return hasApprovedSource ? "needs_mlr" : "blocked_by_compliance";
  return hasApprovedSource ? "needs_mlr" : "needs_source";
}

function instructionFor(type: RuleType, feedback: string, topic?: string): string {
  const fb = feedback.trim();
  switch (type) {
    case "persona_style":
      // Reflect the ACTUAL feedback — only normalize the common "be concise" case.
      // (Previously hardcoded, which made every style rule read identically.)
      return isBrevity(feedback.toLowerCase()) ? "Keep responses concise unless the HCP asks for detail." : fb;
    case "blocked_topic":
      return topic ? `Do not raise "${topic}" unless an approved response exists. (from: "${fb}")` : `Do not raise this topic unless an approved response exists. (from: "${fb}")`;
    case "conversation_ordering":
      return topic ? `Lead with ${topic} using approved content.` : fb;
    case "comparative_claim":
      return "Comparative claims require an active approved source before they may be stated.";
    case "hcp_pointer":
      return fb;
  }
}
