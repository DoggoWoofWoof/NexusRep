/**
 * ASR hotword correction. Browser/Whisper speech-to-text mangles pharma proper nouns it has never
 * seen ("Milvexian" → "malvaxian" / "mil vexian"; "LIBREXIA" → "librexia"; "Factor XIa" → "factor
 * 11a"). The Web Speech API has no custom-vocabulary hook, so we correct the TEXT after the fact:
 * fuzzy-match token windows against the brand's known terms and snap near-misses to the canonical
 * spelling. Pure + deterministic so it's unit-tested and reused wherever a recognizer produces text
 * (off-video voice today; the video path later, if we route ASR client-side).
 *
 * Deliberately conservative: close matches are corrected, plus a tiny allow-list of observed Tavus
 * speech aliases such as "the new vaccine" only inside product/mechanism-style questions. Ordinary
 * vaccine discussion stays literal so it can route safely.
 */

const SIM_THRESHOLD = 0.6; // Levenshtein similarity a window must reach to be snapped to a term.

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function similarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  const m = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / m;
}

/** Consonant skeleton: first letter, then the following consonants (vowels dropped, runs collapsed).
 *  ASR mangles proper nouns mostly by swapping/adding VOWELS ("milvexian"→"milvaxion", "librexia"→
 *  "libraxia"), which leaves the skeleton intact — so a skeleton match catches sound-alikes that
 *  raw edit distance misses. */
function skeleton(s: string): string {
  const n = norm(s);
  if (!n) return "";
  let out = n[0]!;
  for (let i = 1; i < n.length; i++) {
    const c = n[i]!;
    if ("aeiou".includes(c)) continue;
    if (c !== out[out.length - 1]) out += c; // collapse doubled consonants
  }
  return out;
}

/** A window of transcript tokens "matches" a term when it shares the first letter (cheap guard
 *  against snapping unrelated words) AND is either edit-distance-close OR phonetically close
 *  (consonant skeletons align). */
function windowMatches(window: string, term: string): boolean {
  const nw = norm(window);
  const nt = norm(term);
  if (!nw || !nt) return false;
  if (nw === nt) return true;
  if (nw[0] !== nt[0]) return false; // proper nouns almost always survive the first phoneme
  // Short terms need a tighter ratio (fewer chars → each edit costs more), long terms can be looser.
  const threshold = nt.length <= 5 ? 0.72 : SIM_THRESHOLD;
  if (similarity(nw, nt) >= threshold) return true;
  // Phonetic backstop: consonant skeletons equal or near-equal (catches vowel-swap mis-hearings).
  const sw = skeleton(nw);
  const st = skeleton(nt);
  return st.length >= 3 && (sw === st || similarity(sw, st) >= 0.8);
}

export interface TranscriptCorrection {
  text: string;
  corrections: [heard: string, snappedTo: string][];
}

const HCP_ASR_FALLBACK_TERMS = ["Milvexian", "LIBREXIA", "Factor XIa"];

/**
 * The subset of hotwords SAFE to snap TEXT to. Drops any multi-word term that merely EXTENDS a
 * standalone term — e.g. "LIBREXIA AF", "LIBREXIA ACS", "LIBREXIA STROKE" all extend "LIBREXIA".
 * Post-hoc fuzzy text can't tell those siblings apart (the shared "LIBREXIA" prefix dominates the
 * similarity), so it snaps to the wrong trial. As STT *hotwords* they're fine — the raw audio
 * distinguishes them; here the single "LIBREXIA" still fixes the prefix and the distinct suffix word
 * ("AF"/"stroke") is left exactly as heard.
 */
export function correctionTerms(terms: string[]): string[] {
  const singles = new Set(terms.filter((t) => t.trim().split(/\s+/).length === 1).map(norm).filter(Boolean));
  return terms.filter((t) => {
    const words = t.trim().split(/\s+/);
    return words.length === 1 || !singles.has(norm(words[0]!));
  });
}

function speechAliasCorrection(text: string, terms: string[]): TranscriptCorrection {
  const milvexian = terms.find((t) => norm(t) === "milvexian");
  const librexia = terms.find((t) => norm(t) === "librexia");
  if (!milvexian && !librexia) return { text, corrections: [] };
  // Tavus/medical ASR can hear "Milvexian" as "my vaccine" / "the vaccine". Only correct inside
  // a product-style question; a literal vaccine discussion should remain literal and route safely.
  const productQuestion = /\b(?:how\s+(?:does|do|is)|what(?:'s|\s+is)|tell\s+me|explain|mechanism|work|works|program|about)\b/i.test(text);
  if (!productQuestion) return { text, corrections: [] };
  const corrections: [string, string][] = [];
  let out = text;
  if (milvexian) {
    const alias = /\b(?:(?:my|the|new|the\s+new|mil|mill|myl|mal|male|mild|bill)\s+vaccine|mil\s+vax(?:ine|ian|ion)|milvaccine|mylovaxia|milovaxia|mylovexia)\b/gi;
    out = out.replace(alias, (heard) => {
      corrections.push([heard, milvexian]);
      return milvexian;
    });
    // Tavus sometimes drops the determiner entirely and returns a clipped first-turn fragment like
    // "Vaccine work." In this rep context that is a mechanism question about Milvexian, but keep
    // the correction narrow so ordinary vaccine discussion still routes safely.
    out = out.replace(/^\s*vaccine\s+(work|works|mechanism)\b/gi, (heard, tail: string) => {
      corrections.push([heard.trim(), milvexian]);
      return `${milvexian} ${tail}`;
    });
  }
  if (librexia) {
    // Short Tavus collapses of LIBREXIA observed in live calls ("LBILE", "Libile") are too short
    // for edit-distance matching, so handle them only in product/program-style questions.
    out = out.replace(/\bwhat\s+is\s+the\s+(?:bro|brue|brew|pro|prog(?:ram)?)\b/gi, (heard) => {
      corrections.push([heard.trim(), `What is the ${librexia} program`]);
      return `What is the ${librexia} program`;
    });
    const programAlias = /\b(?:liberation|libation|liberexia)\s*,?\s*(?:bro|brue|brew|pro|prog(?:ram)?)\b/gi;
    out = out.replace(programAlias, (heard) => {
      corrections.push([heard.trim(), `${librexia} program`]);
      return `${librexia} program`;
    });
    out = out.replace(/\bliberation\b/gi, (heard) => {
      corrections.push([heard, `${librexia} program`]);
      return `${librexia} program`;
    });
    const alias = /\b(?:l\s*bile|lbile|libile|librix|librixa|librex|lebrex|lebriexia|lebirexia|libr?exia)\b/gi;
    out = out.replace(alias, (heard) => {
      if (norm(heard) === "librexia") return heard; // exact/casing handled by the fuzzy pass below
      corrections.push([heard, librexia]);
      return librexia;
    });
  }
  return { text: out, corrections };
}

/**
 * Snap near-miss token windows in `text` to the canonical `terms`. Multi-word terms are matched
 * first (longest token-length wins), and a single-word term is also tried against a 2-token window
 * (e.g. "mil vexian" → "Milvexian").
 */
export function correctTranscript(text: string, terms: string[]): TranscriptCorrection {
  const canon = [...new Set(terms.map((t) => t.trim()).filter((t) => norm(t).length >= 3))]
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length);
  const alias = speechAliasCorrection(text, canon);
  const tokens = alias.text.split(/\s+/).filter(Boolean);
  if (!canon.length || !tokens.length) return { text, corrections: [] };

  const out: string[] = [];
  const corrections: [string, string][] = [...alias.corrections];
  let i = 0;
  while (i < tokens.length) {
    let hit: { term: string; len: number } | null = null;
    for (const term of canon) {
      const span = term.split(/\s+/).length;
      const winTokens = tokens.slice(i, i + span);
      // Only match a multi-word term against a window of the SAME token count — otherwise a bare
      // "lebrixia" (1 token) fuzzy-matches "LIBREXIA AF" (2 tokens) and wrongly appends "AF",
      // silently narrowing "tell me about LIBREXIA" into a specific trial.
      if (winTokens.length === span && windowMatches(winTokens.join(" "), term)) { hit = { term, len: span }; break; }
      if (span === 1 && i + 2 <= tokens.length) {
        const win2 = tokens.slice(i, i + 2).join(" ");
        if (windowMatches(win2, term)) { hit = { term, len: 2 }; break; }
      }
    }
    if (hit) {
      const heard = tokens.slice(i, i + hit.len).join(" ");
      out.push(hit.term);
      if (heard !== hit.term) corrections.push([heard, hit.term]);
      i += hit.len;
    } else {
      out.push(tokens[i]!);
      i += 1;
    }
  }
  return { text: out.join(" "), corrections };
}

/**
 * Given the recognizer's alternatives (best-first), correct each and pick the one that recovers the
 * most distinct brand terms — Web Speech often hides the right proper noun in alternative #2. Ties
 * keep the earliest (highest-confidence) alternative.
 */
export function correctBestAlternative(
  alternatives: string[],
  terms: string[],
): TranscriptCorrection & { chosenIndex: number } {
  const alts = alternatives.filter((a) => a && a.trim());
  if (!alts.length) return { text: "", corrections: [], chosenIndex: -1 };
  let best = { ...correctTranscript(alts[0]!, terms), chosenIndex: 0 };
  let bestScore = new Set(best.corrections.map((c) => c[1])).size;
  for (let i = 1; i < alts.length; i++) {
    const c = correctTranscript(alts[i]!, terms);
    const score = new Set(c.corrections.map((x) => x[1])).size;
    if (score > bestScore) { best = { ...c, chosenIndex: i }; bestScore = score; }
  }
  return best;
}

export function hcpCorrectionTerms(hotwords: string[] = [], productTerms: string[] = []): string[] {
  return correctionTerms([...hotwords, ...productTerms, ...HCP_ASR_FALLBACK_TERMS]);
}

export function correctHcpAsrText(
  text: string,
  hotwords: string[] = [],
  productTerms: string[] = [],
): TranscriptCorrection {
  return correctTranscript(text, hcpCorrectionTerms(hotwords, productTerms));
}

export function correctHcpAsrBestAlternative(
  alternatives: string[],
  hotwords: string[] = [],
  productTerms: string[] = [],
): TranscriptCorrection & { chosenIndex: number } {
  return correctBestAlternative(alternatives, hcpCorrectionTerms(hotwords, productTerms));
}
