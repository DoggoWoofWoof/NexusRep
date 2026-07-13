/**
 * Semantic grounding validator (brief §18 "response validator"; hard rule: no
 * generated medical claims). When an LLM composes the answer from approved
 * blocks, it MUST NOT introduce content that isn't in those blocks. This check
 * is deterministic — no second LLM call — so it can run on the hot path and
 * fail safe: if the composed text isn't grounded, the caller drops back to the
 * approved text verbatim rather than speaking the drift.
 *
 * Two signals, tuned so the deterministic builder always passes (it IS the
 * block text) while fabricated claims are caught:
 *   1. Numeric grounding — every number in the answer (doses, frequencies,
 *      limits) must appear in the approved blocks. A hallucinated dose is the
 *      highest-risk failure, so any ungrounded number fails immediately.
 *   2. Lexical coverage — the share of content tokens present in the blocks
 *      must clear a threshold, catching wholesale fabrication / topic drift.
 *   3. Claim polarity — a high-stakes claim asserted POSITIVELY in the answer
 *      (approved, indicated, effective, safe, superior…) must also be asserted
 *      positively in the blocks. Token-set coverage alone treats "not FDA
 *      approved" and "FDA approved" as identical (the words all match, and "not"
 *      is a stop word), so a dropped/flipped negation used to pass. This catches
 *      that flip — the single highest-risk fabrication for an investigational drug.
 */

import { env } from "@lib/env";

// Negation cues (apostrophes stripped before lookup) and the high-stakes claim terms whose
// polarity matters. Kept deliberately small + precise; a false positive here is safe (the
// caller falls back to the verbatim approved text), so we err toward catching flips.
const NEG_CUES = new Set([
  "not", "no", "never", "without", "cannot", "cant", "isnt", "arent", "wasnt", "werent",
  "dont", "doesnt", "didnt", "non", "un", "neither", "nor", "yet", "pending", "investigational",
]);
const CLAIM_TERMS = new Set([
  "approved", "approval", "indicated", "recommended", "superior", "safe", "effective",
  "efficacious", "proven", "established", "preferred", "curative", "cures", "guaranteed",
]);

/** Claim terms asserted POSITIVELY (no negation cue in the preceding 4-token window). */
function positiveClaims(text: string): Set<string> {
  const toks = (text.toLowerCase().match(/[a-z']+/g) ?? []).map((t) => t.replace(/'/g, ""));
  const out = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    if (!CLAIM_TERMS.has(toks[i]!)) continue;
    let negated = false;
    for (let j = Math.max(0, i - 4); j < i; j++) if (NEG_CUES.has(toks[j]!)) { negated = true; break; }
    if (!negated) out.add(toks[i]!);
  }
  return out;
}

const STOP = new Set([
  "the", "is", "a", "an", "of", "to", "in", "and", "or", "at", "as", "with", "for", "on", "by",
  "be", "are", "was", "it", "this", "that", "from", "per", "not", "no", "if", "when", "you", "your",
  "i", "we", "our", "can", "may", "will", "should", "would", "one", "any", "up", "out", "so", "than",
  "important", "safety", "information", "isi", "approved", "please", "here", "now", "showing",
]);

function contentTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2 && !STOP.has(t));
}

function numbers(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => /\d/.test(t));
}

export interface GroundingResult {
  grounded: boolean;
  /** Fraction of answer content tokens found in the approved blocks (0–1). */
  coverage: number;
  /** Content tokens in the answer that appear in no approved block. */
  novelTokens: string[];
  /** Numbers in the answer that appear in no approved block (highest risk). */
  ungroundedNumbers: string[];
  /** Claim terms asserted positively in the answer but not positively in any block (a flip). */
  polarityDrift: string[];
}

export interface GroundingInput {
  /** The composed answer body (ISI is appended separately and excluded here). */
  answer: string;
  /** Approved block texts the answer must be grounded in. */
  blocks: string[];
  /** Minimum lexical coverage to be considered grounded. Default 0.5. */
  minCoverage?: number;
}

/** Validate that a composed answer is grounded in the approved blocks. */
export function validateGrounding(input: GroundingInput): GroundingResult {
  // Coverage floor is deployment-configurable (NEXUSREP_GROUNDING_MIN_COVERAGE, default 0.5).
  const minCoverage = input.minCoverage ?? env.groundingMinCoverage;
  const blockToks = new Set<string>();
  const blockNums = new Set<string>();
  for (const b of input.blocks) {
    for (const t of contentTokens(b)) blockToks.add(t);
    for (const n of numbers(b)) blockNums.add(n);
  }

  const answerToks = contentTokens(input.answer);
  const uniqueAnswerToks = [...new Set(answerToks)];
  const novelTokens = uniqueAnswerToks.filter((t) => !blockToks.has(t));
  const matched = uniqueAnswerToks.length - novelTokens.length;
  const coverage = uniqueAnswerToks.length === 0 ? 1 : matched / uniqueAnswerToks.length;

  const ungroundedNumbers = [...new Set(numbers(input.answer))].filter((n) => !blockNums.has(n));

  // Polarity: a positive claim in the answer that the blocks never assert positively is a flip
  // (e.g. "is FDA approved" against "not FDA approved") — the words all match, so only this catches it.
  const blockClaims = new Set<string>();
  for (const b of input.blocks) for (const c of positiveClaims(b)) blockClaims.add(c);
  const polarityDrift = [...positiveClaims(input.answer)].filter((c) => !blockClaims.has(c));

  const grounded = ungroundedNumbers.length === 0 && coverage >= minCoverage && polarityDrift.length === 0;
  return { grounded, coverage, novelTokens, ungroundedNumbers, polarityDrift };
}
