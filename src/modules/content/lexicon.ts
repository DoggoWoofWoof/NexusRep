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

// International Nonproprietary Name (INN) drug stems — WHO-standardized suffixes shared across a drug
// CLASS, not any one brand (-xaban = Factor Xa inhibitors, -mab = antibodies, -sartan = ARBs, …).
// Recognizing them catches drug names — including LOWERCASE comparators like "apixaban" that carry no
// capital/acronym cue — for ANY pharma brand. Pharma-universal, like the AE/ISI compliance concepts;
// it holds zero brand-specific vocabulary, so it generalizes rather than hardcoding Milvexian's world.
const DRUG_STEM = /(?:xaban|parin|sartan|gliptin|gliflozin|tinib|ciclib|rafenib|zumab|ximab|mab|nib|navir|tegravir|ciclovir|prazole|vastatin|statin|dipine|floxacin|conazole|dronate|setron|triptan|profen|coxib|parib|caine|semide|thiazide|glutide)$/;

/**
 * Salient PRODUCT terms from four brand-free signals: ALL-CAPS acronyms (LIBREXIA, ACS, FXIa),
 * capitalized proper nouns (Milvexian, Johnson), capitalized multi-word phrases (Factor XIa, Bristol
 * Myers), and drug names by INN stem (apixaban) — frequency-ranked, stoplisted, deduped. No NLP dep.
 */
export function deriveProductTerms(blocks: { text: string }[], limit = 24): string[] {
  const freq = new Map<string, number>();
  const bump = (t: string, w = 1) => freq.set(t, (freq.get(t) ?? 0) + w);
  for (const b of blocks) {
    // Acronyms / mixed-case program names: ALL-CAPS run (ACS, ISI, LIBREXIA) or Xx…X…digits (FXIa).
    for (const m of b.text.match(/\b[A-Z]{2,10}\b|\b[A-Z][a-zA-Z]*[A-Z][A-Za-z0-9]{0,6}\b/g) ?? []) {
      const t = norm(m);
      if (t.length >= 2 && !STOP.has(t)) bump(t, 2);
    }
    // Capitalized proper nouns NOT at sentence start (so "The" / sentence openers don't dominate).
    for (const m of b.text.match(/(?<=[a-z0-9,;:)\]]\s+)[A-Z][a-z]{3,}/g) ?? []) {
      const t = norm(m);
      if (!STOP.has(t)) bump(t);
    }
    // Capitalized multi-word phrases kept whole (Factor XIa, Bristol Myers) — a real multi-token term.
    for (const m of b.text.match(/\b[A-Z][a-zA-Z]+ [A-Z][a-zA-Z0-9]+\b/g) ?? []) {
      const t = norm(m);
      if (!t.split(" ").every((w) => STOP.has(w))) bump(t);
    }
    // Drug names by INN stem — the only way to catch a LOWERCASE comparator (apixaban); brand-agnostic.
    for (const m of b.text.toLowerCase().match(/\b[a-z]{6,}\b/g) ?? []) {
      if (!STOP.has(m) && DRUG_STEM.test(m)) bump(m, 2);
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
export function deriveTopicSynonyms(blocks: TopicedBlock[], perTopic = 12): Record<string, string[]> {
  const tokensByTopic = new Map<string, string[]>();
  const topicsPerTerm = new Map<string, Set<string>>();
  for (const b of blocks) {
    const words = tokenize(b.text).filter((t) => t.length > 3);
    // ALSO keep short ALL-CAPS acronyms (AF, ACS, TIA, FXIa) — strong topic markers the length filter
    // above would otherwise drop. Taken from the ORIGINAL text so casing survives, then normalized.
    const acronyms = (b.text.match(/\b[A-Z]{2,6}\b|\b[A-Z][a-z]*[A-Z][A-Za-z0-9]{0,4}\b/g) ?? [])
      .map(norm)
      .filter((a) => a.length >= 2 && !STOP.has(a));
    const toks = [...words, ...acronyms];
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
    // Rank by score, then prefer the LONGER term (a distinctive domain word like "thrombosis" is a more
    // useful synonym than a short common one at the same score), then alphabetical for determinism.
    out[topic] = scored
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
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

/**
 * Precision pass for feeding derived synonyms into the retrieval re-rank: keep only terms DISTINCTIVE
 * to a single topic. A term appearing under two+ topics (e.g. "indications", "three") is non-specific
 * noise that cross-contaminates routing — dropping it is what lets the derived synonyms enrich matching
 * without tilting borderline cases. (The full derived set is still kept for the benchmark + candidates.)
 */
export function distinctiveTopicSynonyms(topicSynonyms: Record<string, string[]>): Record<string, string[]> {
  const topicsPerTerm = new Map<string, number>();
  for (const words of Object.values(topicSynonyms)) for (const w of new Set(words)) topicsPerTerm.set(w, (topicsPerTerm.get(w) ?? 0) + 1);
  const out: Record<string, string[]> = {};
  for (const [topic, words] of Object.entries(topicSynonyms)) out[topic] = words.filter((w) => (topicsPerTerm.get(w) ?? 0) <= 1);
  return out;
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
  /** Fraction of hand-authored topic synonyms recovered under the SAME topic key (strict — undersells
   *  when the ingested content uses finer-grained topics than the reference). */
  topicSynonymRecall: number;
  /** Fraction of hand-authored topic synonyms the derivation surfaced ANYWHERE (any topic, or as a
   *  product term). This is the real "will the runtime UNION cover it?" number. */
  topicSynonymRecallGlobal: number;
  /** Hand-authored topic terms not derived under ANY topic — the residue that still needs authoring. */
  topicTermsMissedGlobal: string[];
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

  // Every derived vocabulary term (topic synonyms + product terms) — what the runtime union provides.
  const allDerived = new Set<string>(derived.productTerms.map(norm));
  for (const terms of Object.values(derived.topicSynonyms)) for (const t of terms) allDerived.add(norm(t));

  let topicHit = 0;
  let topicTotal = 0;
  let globalHit = 0;
  const topicTermsMissedGlobal: string[] = [];
  for (const [topic, refTerms] of Object.entries(reference.topicSynonyms)) {
    const der = new Set((derived.topicSynonyms[topic] ?? []).map(norm));
    for (const rt of refTerms.map(norm)) {
      topicTotal += 1;
      if (fuzzyHas(der, rt)) topicHit += 1; // strict: same topic key
      if (fuzzyHas(allDerived, rt)) globalHit += 1; // global: anywhere in the derived vocabulary
      else topicTermsMissedGlobal.push(rt);
    }
  }

  return {
    productTermRecall: refP.length ? found.length / refP.length : 1,
    productTermsFound: found,
    productTermsMissed: missed,
    productTermsExtra: extra,
    topicSynonymRecall: topicTotal ? topicHit / topicTotal : 1,
    topicSynonymRecallGlobal: topicTotal ? globalHit / topicTotal : 1,
    topicTermsMissedGlobal: [...new Set(topicTermsMissedGlobal)],
  };
}
