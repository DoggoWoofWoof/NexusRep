/**
 * Dynamic lexicon derivation — LEARN a brand's vocabulary from its ingested documents instead of
 * hand-authoring it in the BrandProfile. Two outputs, matching the lexicon shape the engine already
 * consumes (classifier product terms + per-topic retrieval synonyms):
 *   - productTerms   ← salient proper nouns / acronyms recurring across the content
 *   - topicSynonyms  ← the terms that DISTINGUISH each topic's blocks (a TF-IDF-style score)
 *
 * The hand-authored lexicon is NOT deleted. It stays as (a) a runtime FLOOR — callers union derived
 * ∪ hardcoded so nothing regresses — and (b) a BENCHMARK: scoreLexiconCoverage() reports how close the
 * derived set gets to it, so the extraction can be tuned toward "a brand-new brand needs no authoring".
 * Pure + deterministic (unit-testable); contains ZERO brand-specific terms itself.
 */

export interface Lexicon {
  productTerms: string[];
  topicSynonyms: Record<string, string[]>;
}

export interface TopicedBlock {
  text: string;
  topic: string;
}

// A generic English stoplist — NOT brand vocabulary. Common words that must never become product/topic
// terms. Deliberately excludes anything domain-specific so the derivation stays brand-free.
const STOP = new Set(
  ("the a an and or of to in on at for with by is are was were be been being as from this that these those it its our your their we you they i he she them his her which who whom what when where how why will would can could should shall may might must not no nor yes if then else than so such into over under about above below more most less least very much many any all each both few several other some own same once here there also just only per via within without across after before during between our not do does did done have has had having but because while both either neither than up out off down again further" +
    " they'll we'll you'll it's that's there's here's approved content slide slides deck page pages information info please note e.g i.e etc versus vs use using used based per").split(/\s+/),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

const norm = (s: string): string => s.toLowerCase().trim();

/**
 * Salient PRODUCT terms: ALL-CAPS acronyms (LIBREXIA, ACS, FXIa) + capitalized proper nouns that recur
 * (Milvexian, Apixaban) — frequency-ranked, stoplisted, deduped. Heuristic, no NLP dependency.
 */
export function deriveProductTerms(blocks: { text: string }[], limit = 24): string[] {
  const freq = new Map<string, number>();
  const bump = (t: string) => freq.set(t, (freq.get(t) ?? 0) + 1);
  for (const b of blocks) {
    // Acronyms / mixed-case program names: ALL-CAPS run (ACS, ISI, LIBREXIA) or Xx…X…digits (FXIa).
    for (const m of b.text.match(/\b[A-Z]{2,10}\b|\b[A-Z][a-zA-Z]*[A-Z][A-Za-z0-9]{0,6}\b/g) ?? []) {
      const t = norm(m);
      if (t.length >= 2 && !STOP.has(t)) bump(t);
    }
    // Capitalized proper nouns NOT at sentence start (so "The" / sentence openers don't dominate).
    for (const m of b.text.match(/(?<=[a-z0-9,;:)\]]\s+)[A-Z][a-z]{3,}/g) ?? []) {
      const t = norm(m);
      if (!STOP.has(t)) bump(t);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([t]) => t);
}

/**
 * Per-topic SYNONYMS via a TF-IDF-style score: a term scores high for a topic when it's frequent in
 * that topic's blocks AND rare across other topics (i.e. it distinguishes the topic).
 */
export function deriveTopicSynonyms(blocks: TopicedBlock[], perTopic = 8): Record<string, string[]> {
  const tokensByTopic = new Map<string, string[]>();
  const topicsPerTerm = new Map<string, Set<string>>();
  for (const b of blocks) {
    const toks = tokenize(b.text).filter((t) => t.length > 3);
    tokensByTopic.set(b.topic, (tokensByTopic.get(b.topic) ?? []).concat(toks));
    for (const t of new Set(toks)) {
      const s = topicsPerTerm.get(t) ?? new Set<string>();
      s.add(b.topic);
      topicsPerTerm.set(t, s);
    }
  }
  const topicCount = tokensByTopic.size || 1;
  const out: Record<string, string[]> = {};
  for (const [topic, toks] of tokensByTopic) {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    const scored = [...tf.entries()].map(([t, f]) => {
      const idf = Math.log((topicCount + 1) / (topicsPerTerm.get(t)?.size ?? 1));
      return [t, f * (idf + 0.05)] as [string, number];
    });
    out[topic] = scored
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, perTopic)
      .map(([t]) => t);
  }
  return out;
}

/** Derive the full lexicon from ingested, topic-tagged blocks. */
export function deriveLexicon(blocks: TopicedBlock[], opts?: { productLimit?: number; perTopic?: number }): Lexicon {
  return {
    productTerms: deriveProductTerms(blocks, opts?.productLimit),
    topicSynonyms: deriveTopicSynonyms(blocks, opts?.perTopic),
  };
}

/** Union derived ∪ reference (hand-authored stays a floor). Reference terms come first, deduped. */
export function mergeLexicon(derived: Lexicon, reference: Lexicon): Lexicon {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const topics = new Set([...Object.keys(reference.topicSynonyms), ...Object.keys(derived.topicSynonyms)]);
  const topicSynonyms: Record<string, string[]> = {};
  for (const t of topics) topicSynonyms[t] = uniq([...(reference.topicSynonyms[t] ?? []), ...(derived.topicSynonyms[t] ?? [])]);
  return { productTerms: uniq([...reference.productTerms, ...derived.productTerms]), topicSynonyms };
}

export interface LexiconCoverage {
  /** Fraction of the hand-authored productTerms the derivation recovered (fuzzy substring match). */
  productTermRecall: number;
  productTermsFound: string[];
  productTermsMissed: string[];
  /** Derived terms NOT in the reference — candidate new vocabulary the hand-authored set lacked. */
  productTermsExtra: string[];
  /** Fraction of hand-authored topic synonyms recovered, across all reference topics. */
  topicSynonymRecall: number;
}

const fuzzyHas = (set: Set<string>, term: string): boolean =>
  set.has(term) || [...set].some((d) => d.length > 2 && (d.includes(term) || term.includes(d)));

/**
 * Benchmark the derived lexicon against the hand-authored one: how much of the known-good vocabulary
 * did the dynamic extraction recover, and what extra candidates did it surface? This is the readout
 * that tells you how far "learn it at ingest" is from "no authoring needed".
 */
export function scoreLexiconCoverage(derived: Lexicon, reference: Lexicon): LexiconCoverage {
  const refP = [...new Set(reference.productTerms.map(norm))];
  const derP = new Set(derived.productTerms.map(norm));
  const found = refP.filter((t) => fuzzyHas(derP, t));
  const missed = refP.filter((t) => !fuzzyHas(derP, t));
  const refPset = new Set(refP);
  const extra = [...derP].filter((t) => !fuzzyHas(refPset, t)).slice(0, 24);

  let topicHit = 0;
  let topicTotal = 0;
  for (const [topic, refTerms] of Object.entries(reference.topicSynonyms)) {
    const der = new Set((derived.topicSynonyms[topic] ?? []).map(norm));
    for (const rt of refTerms.map(norm)) {
      topicTotal += 1;
      if (fuzzyHas(der, rt)) topicHit += 1;
    }
  }

  return {
    productTermRecall: refP.length ? found.length / refP.length : 1,
    productTermsFound: found,
    productTermsMissed: missed,
    productTermsExtra: extra,
    topicSynonymRecall: topicTotal ? topicHit / topicTotal : 1,
  };
}
