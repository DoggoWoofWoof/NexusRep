/**
 * Combined intent/risk classifier. The brief calls for ONE optimized call that
 * returns intent + off-label/AE/medical-info/prompt-injection/comparative risk +
 * ISI requirement (brief §18, latency-aware). This mock is deterministic keyword
 * scoring — a real implementation swaps the internals, not the signature.
 */

import type { Intent, RiskClassification } from "./types";

// Symptom mentions strong enough to take the safe (adverse-event) path on their own —
// a doctor raising any of these gets caution/PV routing regardless of phrasing.
const AE_SYMPTOM_TERMS = [
  "rash", "nausea", "dizzy", "dizziness", "hospitalized", "bleeding",
  "swelling", "allergic", "anaphylax", "fainted", "died", "death",
];
// Ambiguous terms: an adverse-event REPORT only when a report cue is also present —
// otherwise "what are the side effects?" is a safety QUESTION, not a report to route
// to pharmacovigilance. (The safety intent below picks up the no-cue case.)
const AE_REPORT_TERMS = ["side effect", "adverse event", "adverse reaction", "adverse", "reaction"];
const AE_REPORT_CUES = [
  "my patient", "patient had", "patient experienced", "experienced", "developed",
  "after taking", "after starting", "after a dose", "reported", "presented with",
  "came in with", "i had", "i experienced", "she had", "he had", "they had", "started having",
];
const OFF_LABEL_TERMS = [
  "off-label", "off label", "pediatric", "children", "pregnan", "unapproved",
  "other indication", "not approved for", "weight loss",
];
// "superior to" (not bare "superior") — otherwise cardiology anatomy like
// "superior vena cava" false-fires the comparative route.
const COMPARATIVE_TERMS = ["better than", "safer than", "superior to", "more effective than", "versus", "vs", "compared to", "competitor"];
const INJECTION_TERMS = ["ignore previous", "ignore the above", "system prompt", "developer mode", "jailbreak"];
const HUMAN_TERMS = ["talk to a person", "human rep", "representative", "call me", "sales rep", "speak to someone"];
const MSL_TERMS = ["pharmacokinetic", "data on file", "study design", "medical information", "msl"];
const DEEP_TRIAL_RESULT_TERMS = ["efficacy", "endpoint", "outcome", "results", "published", "latest data", "clinical data"];
const PATIENT_USE_TERMS = [
  "should i prescribe", "can i prescribe", "prescribe it", "prescribe this",
  "should i use", "can i use", "should we use", "can we use",
  "should i give", "can i give", "start my patient", "start patients",
  "use it for my patient", "use it for my patients", "for my patient", "for my patients",
  "recommend it", "recommend this",
];

// Order matters: clinical-specifics intents are listed FIRST so that on a term
// tie they win over the general product_info intent — the safe direction, since
// the investigational guardrail then routes clinical specifics to Medical Info.
const INTENT_TERMS: Record<Exclude<Intent, "off_label" | "adverse_event" | "comparative" | "human_request" | "other">, string[]> = {
  dosing: ["dose", "dosing", "titration", "mg", "how much", "frequency"],
  safety: ["safety", "contraindicat", "warning", "isi", "risk", "side effect", "adverse", "reaction", "tolerab"],
  administration: ["administer", "injection", "infusion", "how to take", "route"],
  trial_data: ["trial", "study", "efficacy", "endpoint", "clinical data", "results"],
  access: ["coverage", "cost", "access", "insurance", "copay", "reimburs"],
  // Publicly-disclosable product facts (mechanism, program, status) — the ONLY
  // topics an investigational rep answers directly. GENERIC terms only; product/
  // program names come from the brand lexicon (configureClassifierLexicon).
  product_info: [
    "what is", "what's", "tell me about", "tell me more", "explain", "mechanism", "how does", "moa",
    "program", "indication", "investigational", "fast track", "development", "class of drug",
    "why focus", "rationale", "factor xia", "fxia", "clotting", "coagulation", "cascade", "pathway",
    "thrombin", "hemostasis",
    // Presentation requests — the rep presents its OWN approved deck (agentic), not a human handoff.
    "slide", "slides", "deck", "presentation", "detail aid", "show me", "show your", "show your slides",
    "walk me through", "what do you have", "what can you show", "present",
  ],
};

// Brand lexicon: product/program names contribute to product_info intent WITHOUT living
// in this generic engine file. The container configures this once from the BrandProfile,
// so onboarding a new brand never edits the classifier.
let PRODUCT_TERMS: string[] = [];
let PRODUCT_CANON: { despaced: string; display: string }[] = [];
function canonicalDisplay(term: string): string {
  const clean = term.trim();
  const compact = clean.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "librexia") return "LIBREXIA";
  if (compact === "fxia") return "FXIa";
  if (compact === "factorxia" || compact === "factorxi") return "Factor XIa";
  if (compact === "milvexian") return "Milvexian";
  if (clean === clean.toUpperCase() && /[A-Z]/.test(clean)) return clean;
  return clean.replace(/\b\w/g, (c) => c.toUpperCase());
}
export function configureClassifierLexicon(productTerms: string[]): void {
  PRODUCT_TERMS = productTerms.map((t) => t.toLowerCase().trim()).filter(Boolean);
  // Canonicalization targets EXCLUDE any multi-word term whose FIRST word is itself a standalone
  // term — e.g. "librexia af" / "librexia stroke" extend "librexia". Otherwise a bare (or near)
  // "librexia" fuzzy-snaps to a 2-word combo and appends a trial suffix the doctor never said, which
  // then skews retrieval to that trial. Classification still sees every term (PRODUCT_TERMS) — only
  // the fuzzy spelling-fixer is restricted, so it corrects spelling without inventing content.
  const singles = new Set(PRODUCT_TERMS.filter((t) => t.split(/\s+/).length === 1).map((t) => t.replace(/[^a-z0-9]/g, "")));
  PRODUCT_CANON = PRODUCT_TERMS
    .filter((t) => { const w = t.split(/\s+/); return w.length === 1 || !singles.has(w[0]!.replace(/[^a-z0-9]/g, "")); })
    .map((t) => ({
      despaced: t.replace(/[^a-z0-9]/g, ""),
      display: canonicalDisplay(t),
    }));
}

/** Longest common CONTIGUOUS substring length — the fuzzy signal for a mistranscribed name. */
function longestCommonSubstr(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagPrev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      if (a[i - 1] === b[j - 1]) { row[j] = diagPrev + 1; if (row[j]! > best) best = row[j]!; }
      else row[j] = 0;
      diagPrev = tmp;
    }
  }
  return best;
}

function editDistanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    cur[0] = i;
    let rowBest = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      rowBest = Math.min(rowBest, cur[j]!);
    }
    if (rowBest > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

function commonSpeechAliasReplacements(input: string): { start: number; end: number; display: string }[] {
  const milvexian = PRODUCT_CANON.find((t) => t.despaced === "milvexian");
  const librexia = PRODUCT_CANON.find((t) => t.despaced === "librexia");
  if (!milvexian && !librexia) return [];
  // "Milvexian" is repeatedly heard as "my vaccine" / "the vaccine" in Tavus ASR. Only correct it
  // inside a product-style question so ordinary vaccine talk is not silently turned into the brand.
  const productQuestion = /\b(?:how\s+(?:does|do|is)|what(?:'s|\s+is)|tell\s+me|explain|mechanism|work|works|program|about)\b/i.test(input);
  if (!productQuestion) return [];
  const repls: { start: number; end: number; display: string }[] = [];
  if (milvexian) {
    const alias = /\b(?:(?:my|the|mil|mill|myl|mal|male|mild|bill)\s+vaccine|mil\s+vax(?:ine|ian|ion)|milvaccine|mylovaxia|milovaxia|mylovexia)\b/gi;
    for (const m of input.matchAll(alias)) {
      repls.push({ start: m.index!, end: m.index! + m[0].length, display: milvexian.display });
    }
    const bareVaccine = /^\s*vaccine\s+(?:work|works|mechanism)\b/i.exec(input);
    if (bareVaccine) {
      const start = input.search(/\bvaccine\b/i);
      repls.push({ start, end: start + "vaccine".length, display: milvexian.display });
    }
  }
  if (librexia) {
    const programAlias = /\b(?:liberation|libation|liberexia)\s*,?\s*(?:bro|pro|prog(?:ram)?)\b/gi;
    for (const m of input.matchAll(programAlias)) {
      repls.push({ start: m.index!, end: m.index! + m[0].length, display: `${librexia.display} program` });
    }
    const clippedProgramAlias = /\bliberation\b/gi;
    for (const m of input.matchAll(clippedProgramAlias)) {
      repls.push({ start: m.index!, end: m.index! + m[0].length, display: `${librexia.display} program` });
    }
  }
  return repls;
}

function nonOverlappingReplacements(repls: { start: number; end: number; display: string }[]): { start: number; end: number; display: string }[] {
  const chosen: { start: number; end: number; display: string }[] = [];
  for (const repl of [...repls].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))) {
    if (chosen.some((r) => repl.start < r.end && repl.end > r.start)) continue;
    chosen.push(repl);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/**
 * Recover an ASR/typo near-miss of a product name ("no vexian", "novexian", "milvexin" →
 * "Milvexian") so a garbled name still classifies as a product question AND retrieves the
 * right approved content — instead of bouncing to the human-handoff fallback.
 *
 * Conservative by design: only product terms ≥6 chars, needs a ≥6-char contiguous overlap
 * that is also ≥60% of the term with a length within 3 — a random word can't trip it, and
 * exact matches pass through untouched. Runs on 2-word then 1-word windows so "no vexian"
 * is caught as one name.
 */
export function canonicalizeProductNames(input: string): string {
  if (!PRODUCT_CANON.length || !input) return input;
  const tokens = [...input.matchAll(/\S+/g)].map((m) => ({ raw: m[0], start: m.index!, end: m.index! + m[0].length }));
  if (!tokens.length) return input;
  const norm = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, "");
  const repls: { start: number; end: number; display: string }[] = nonOverlappingReplacements(commonSpeechAliasReplacements(input));
  const used = new Array<boolean>(tokens.length).fill(false);
  for (let i = 0; i < tokens.length; i++) {
    if (repls.some((r) => tokens[i]!.start >= r.start && tokens[i]!.end <= r.end)) used[i] = true;
  }
  for (const win of [1, 2]) {
    for (let i = 0; i + win <= tokens.length; i++) {
      if (used.slice(i, i + win).some(Boolean)) continue;
      const cand = norm(tokens.slice(i, i + win).map((t) => t.raw).join(""));
      if (cand.length < 4) continue;
      for (const term of PRODUCT_CANON) {
        if (term.despaced.length < 6 || cand === term.despaced) continue; // tiny terms + exact hits: leave alone
        // Never ADD words: a bare "LIBREXIA" must not snap to the 2-word "LIBREXIA AF" (that inserts a
        // trial suffix the doctor never said and then skews retrieval to that trial). Canonicalize
        // spelling within the SAME word count, or CONTRACT ("no vexian" → "Milvexian") — never expand.
        if (term.display.trim().split(/\s+/).length > win) continue;
        // Also never CONTRACT an exact canonical product/program token plus a meaningful suffix into
        // the base term. "LIBREXIA AF" must stay trial-specific; only true split-name ASR misses such
        // as "no vexian" should contract to "Milvexian".
        if (win > 1 && term.display.trim().split(/\s+/).length === 1) {
          const rawWindow = tokens.slice(i, i + win).map((t) => norm(t.raw));
          if (rawWindow.includes(term.despaced)) continue;
        }
        const lcs = longestCommonSubstr(cand, term.despaced);
        const nearEdit =
          term.despaced.length >= 7 &&
          cand[0] === term.despaced[0] &&
          cand.length >= term.despaced.length - 2 &&
          editDistanceWithin(cand, term.despaced, 3) <= 3;
        if ((lcs >= 6 && lcs >= Math.ceil(term.despaced.length * 0.6) && Math.abs(cand.length - term.despaced.length) <= 2) || nearEdit) {
          repls.push({ start: tokens[i]!.start, end: tokens[i + win - 1]!.end, display: term.display });
          for (let k = i; k < i + win; k++) used[k] = true;
          break;
        }
      }
    }
  }
  if (!repls.length) return input;
  repls.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const r of repls) { out += input.slice(cursor, r.start) + r.display; cursor = r.end; }
  return out + input.slice(cursor);
}

/** Whole-word-ish containment: the term must begin at a word boundary, so "side" no
 *  longer matches inside "consider" and "risk" no longer matches "asterisk" — while
 *  intentional prefixes ("pregnan" → "pregnancy") and unit-after-digit ("mg" → "5mg")
 *  still match. Multi-word phrases match across flexible whitespace. */
function matchesTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z])(${escaped})`, "i").test(text);
}

function hits(text: string, terms: string[]): number {
  return terms.reduce((n, t) => (matchesTerm(text, t) ? n + 1 : n), 0);
}

export function classify(input: string): RiskClassification {
  const text = input.toLowerCase();

  // A symptom mention is an AE on its own; an ambiguous term ("side effect", "reaction")
  // is an AE only WITH a report cue — so a safety QUESTION doesn't file a PV report.
  const aeReport = hits(text, AE_REPORT_TERMS) > 0 && hits(text, AE_REPORT_CUES) > 0;
  const aeRisk = clamp(hits(text, AE_SYMPTOM_TERMS) * 0.6 + (aeReport ? 0.6 : 0));
  const offLabelRisk = clamp(hits(text, OFF_LABEL_TERMS) * 0.7);
  const comparativeRisk = clamp(hits(text, COMPARATIVE_TERMS) * 0.7);
  const injectionRisk = clamp(hits(text, INJECTION_TERMS) * 0.8);
  const patientUse = hits(text, PATIENT_USE_TERMS) > 0;
  const deepTrialResults = hits(text, DEEP_TRIAL_RESULT_TERMS) > 0;
  const medicalInfoRisk = clamp(hits(text, MSL_TERMS) * 0.6 + (patientUse ? 0.8 : 0) + (deepTrialResults ? 0.8 : 0));

  // Intent priority: safety-critical routes win over informational intents.
  let intent: Intent = "other";
  let confidence = 0.5;
  if (aeRisk >= 0.6) {
    intent = "adverse_event";
    confidence = 0.9;
  } else if (offLabelRisk >= 0.7) {
    intent = "off_label";
    confidence = 0.85;
  } else if (comparativeRisk >= 0.7) {
    intent = "comparative";
    confidence = 0.8;
  } else if (patientUse) {
    intent = "administration";
    confidence = 0.85;
  } else if (deepTrialResults) {
    intent = "trial_data";
    confidence = 0.85;
  } else if (hits(text, HUMAN_TERMS) > 0) {
    intent = "human_request";
    confidence = 0.85;
  } else {
    let best = 0;
    for (const [name, terms] of Object.entries(INTENT_TERMS)) {
      // Mentioning the product/program by name is a public-info signal (brand lexicon).
      const score = hits(text, terms) + (name === "product_info" ? hits(text, PRODUCT_TERMS) : 0);
      if (score > best) {
        best = score;
        intent = name as Intent;
        confidence = clamp(0.6 + score * 0.1);
      }
    }
  }

  // Product-info answers carry the investigational disclosure; safety/dosing/
  // administration answers require ISI delivery when a launched product is in play.
  const isiRequired = ["product_info", "safety", "dosing", "administration", "trial_data"].includes(intent);

  return {
    intent,
    confidence,
    offLabelRisk,
    adverseEventRisk: aeRisk,
    medicalInfoRisk,
    promptInjectionRisk: injectionRisk,
    comparativeClaimRisk: comparativeRisk,
    isiRequired,
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
