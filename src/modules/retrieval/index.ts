/**
 * Controlled retrieval (brief §17; PDF §6). The flow is strict:
 *
 *   question → metadata-filtered vector search → candidate IDs
 *            → Postgres/canonical source validation → eligible approved blocks
 *
 * The vector index NEVER decides eligibility — it only proposes candidates.
 * Every candidate is resolved back to a canonical record and validated before
 * it can be used to build a response.
 */

import type { ApprovedAnswerId } from "@lib/ids";
import { asId } from "@lib/ids";
import { isOk } from "@lib/result";
import { getEmbeddingMode } from "@lib/embeddings";
import {
  ContentService,
  type ApprovedAnswer,
  type SourceValidationContext,
} from "@modules/content";
import type { RetrievalProvider } from "@modules/vendors";

export interface RetrievalRequest {
  text: string;
  context: SourceValidationContext & { audience?: string; indication?: string; market?: string };
  topK?: number;
}

export interface RetrievalResult {
  answers: ApprovedAnswer[];
  /** Candidates that were proposed but failed source validation (for audit/content-gap). */
  rejected: { refId: string; reason: string }[];
}

export class RetrievalService {
  constructor(
    private readonly provider: RetrievalProvider,
    private readonly content: ContentService,
  ) {}

  async retrieveApproved(req: RetrievalRequest): Promise<RetrievalResult> {
    const filter: Record<string, string> = {};
    if (req.context.audience) filter.audience = req.context.audience;
    if (req.context.indication) filter.indication = req.context.indication;
    if (req.context.market) filter.market = req.context.market;

    const candidates = await this.provider.retrieve({
      text: req.text,
      filter,
      topK: req.topK ?? 5,
    });

    const answers: ApprovedAnswer[] = [];
    const rejected: { refId: string; reason: string }[] = [];

    for (const candidate of candidates) {
      const id = asId<"approved_answer_id">(candidate.refId) as ApprovedAnswerId;
      const validated = await this.content.validateAnswer(id, req.context);
      if (isOk(validated)) answers.push(validated.value);
      else rejected.push({ refId: candidate.refId, reason: validated.error });
    }

    // Ordering: with NEURAL embeddings active, the vector cosine IS the relevance signal — trust it
    // and DON'T let the keyword re-rank override it (that was hijacking specific questions, e.g.
    // "the atrial fibrillation trial" → the generic program block, because a keyword topic-bonus
    // outweighed the semantically-correct AF block). The keyword re-rank stays only for the
    // deterministic lexical fallback (offline / CI / no model), where there's no semantic score.
    const ordered =
      getEmbeddingMode() === "neural" && !hasStrongMechanismIntent(req.text)
        ? answers
        : rerankApprovedAnswers(req.text, answers);
    return { answers: ordered, rejected };
  }
}

const STOP = new Set([
  "the", "is", "a", "an", "of", "to", "in", "and", "or", "at", "as", "with", "for", "on", "by",
  "be", "are", "was", "it", "this", "that", "from", "per", "what", "which", "do", "does", "can",
  "i", "you", "your", "me", "my", "about", "tell", "show", "approved", "information",
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

function hasAny(hay: Set<string>, terms: string[]): boolean {
  return terms.some((t) => hay.has(t));
}

// Brand lexicon: topic → extra query words that should pull that topic forward (e.g. the
// program's trial name, the target pathway). Configured by the container from the
// BrandProfile so this engine file stays brand-free.
let TOPIC_SYNONYMS: Record<string, string[]> = {};
export function configureRetrievalLexicon(topicSynonyms: Record<string, string[]>): void {
  TOPIC_SYNONYMS = Object.fromEntries(
    Object.entries(topicSynonyms).map(([topic, words]) => [topic.toLowerCase(), words.map((w) => w.toLowerCase().trim()).filter(Boolean)]),
  );
}

function topicBonus(query: string, queryWords: Set<string>, answer: ApprovedAnswer): number {
  const topic = answer.topic.toLowerCase();
  let bonus = 0;
  const synonymHits = new Set(
    Object.entries(TOPIC_SYNONYMS)
      .filter(([, words]) => hasAny(queryWords, words))
      .map(([topicKey]) => topicKey),
  );
  const namedProgramHit = [...synonymHits].some((topicKey) => /program|trial|study/.test(topicKey));
  const namedMechanismHit = [...synonymHits].some((topicKey) => /mechanism|moa|action/.test(topicKey));

  // GENERIC clinical groupings only — brand vocabulary comes from TOPIC_SYNONYMS below.
  if (
    hasAny(queryWords, ["mechanism", "moa", "pathway", "fit"]) ||
    (/\bhow\s+(?:does|do|is)\b/i.test(query) && !namedProgramHit) ||
    (hasAny(queryWords, ["work", "works", "working"]) && !namedProgramHit)
  ) {
    if (/mechanism|action/i.test(topic)) bonus += 10;
  }
  if (hasAny(queryWords, ["program", "trial", "trials", "study", "studying", "phase"])) {
    if (/program|study|trial/i.test(topic)) bonus += 10;
  }
  if (hasAny(queryWords, ["fda", "status", "approved", "approval", "fast", "track", "investigational", "development"])) {
    if (/status|development|approved|approval/i.test(topic)) bonus += 10;
  }
  // Brand lexicon synonyms: query words specific to this brand's world pull their topic forward.
  for (const [topicKey, words] of Object.entries(TOPIC_SYNONYMS)) {
    if (hasAny(queryWords, words) && topic.includes(topicKey)) bonus += /program|trial|study/.test(topicKey) ? 16 : 12;
  }
  if (namedProgramHit && /mechanism|action/i.test(topic) && !namedMechanismHit) bonus -= 8;
  if (hasAny(queryWords, ["isi", "safety", "disclosure", "warning", "warnings"])) {
    if (/safety|isi|important safety/i.test(topic)) bonus += 10;
  }
  if (hasAny(queryWords, ["contact", "reach", "human", "representative", "rep", "msl", "medical", "pharmacovigilance", "follow"])) {
    if (/contact|medical information|representative|handoff/i.test(topic)) bonus += 10;
  }
  if (hasAny(queryWords, ["overview", "intro", "introduce", "picture", "rundown"])) {
    if (/overview|title|introduction/i.test(topic)) bonus += 5;
  }

  // Broad title/overview copy often shares product words with every deeper block.
  // When the doctor asks a substantive topic question, prefer the specific block.
  if (/overview|title|introduction/i.test(topic) && !hasAny(queryWords, ["overview", "intro", "introduce", "picture", "rundown"])) {
    bonus -= 4;
  }
  return bonus;
}

function namedProgramSignal(queryWords: Set<string>): boolean {
  const synonymHits = new Set(
    Object.entries(TOPIC_SYNONYMS)
      .filter(([, words]) => hasAny(queryWords, words))
      .map(([topicKey]) => topicKey),
  );
  return [...synonymHits].some((topicKey) => /program|trial|study/.test(topicKey));
}

function hasStrongMechanismIntent(query: string): boolean {
  const queryWords = new Set(tokens(query));
  if (!queryWords.size) return false;
  const namedProgramHit = namedProgramSignal(queryWords);
  return (
    hasAny(queryWords, ["mechanism", "moa", "pathway", "fit"]) ||
    (/\bhow\s+(?:does|do|is)\b/i.test(query) && !namedProgramHit) ||
    (hasAny(queryWords, ["work", "works", "working"]) && !namedProgramHit)
  );
}

function lexicalOverlap(queryWords: Set<string>, answer: ApprovedAnswer): number {
  const topicWords = new Set(tokens(answer.topic));
  const bodyWords = new Set(tokens(answer.text));
  let score = 0;
  for (const word of queryWords) {
    if (topicWords.has(word)) score += 3;
    if (bodyWords.has(word)) score += 1;
  }
  return score;
}

function rerankApprovedAnswers(query: string, answers: ApprovedAnswer[]): ApprovedAnswer[] {
  const queryWords = new Set(tokens(query));
  if (!queryWords.size || answers.length <= 1) return answers;
  return answers
    .map((answer, index) => ({
      answer,
      index,
      score: lexicalOverlap(queryWords, answer) + topicBonus(query, queryWords, answer),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.answer);
}
