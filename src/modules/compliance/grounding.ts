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
 */

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
  const minCoverage = input.minCoverage ?? 0.5;
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

  const grounded = ungroundedNumbers.length === 0 && coverage >= minCoverage;
  return { grounded, coverage, novelTokens, ungroundedNumbers };
}
