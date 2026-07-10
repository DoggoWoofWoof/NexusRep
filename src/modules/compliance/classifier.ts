/**
 * Combined intent/risk classifier. The brief calls for ONE optimized call that
 * returns intent + off-label/AE/medical-info/prompt-injection/comparative risk +
 * ISI requirement (brief §18, latency-aware). This mock is deterministic keyword
 * scoring — a real implementation swaps the internals, not the signature.
 */

import type { Intent, RiskClassification } from "./types";

const AE_TERMS = [
  "side effect", "adverse", "reaction", "rash", "nausea", "dizzy", "dizziness",
  "hospitalized", "bleeding", "swelling", "allergic", "fainted", "death",
];
const OFF_LABEL_TERMS = [
  "off-label", "off label", "pediatric", "children", "pregnan", "unapproved",
  "other indication", "not approved for", "weight loss",
];
const COMPARATIVE_TERMS = ["better than", "safer than", "superior", "versus", "vs ", "compared to", "competitor"];
const INJECTION_TERMS = ["ignore previous", "ignore the above", "system prompt", "developer mode", "jailbreak"];
const HUMAN_TERMS = ["talk to a person", "human rep", "representative", "call me", "sales rep", "speak to someone"];
const MSL_TERMS = ["pharmacokinetic", "data on file", "study design", "medical information", "msl"];

// Order matters: clinical-specifics intents are listed FIRST so that on a term
// tie they win over the general product_info intent — the safe direction, since
// the investigational guardrail then routes clinical specifics to Medical Info.
const INTENT_TERMS: Record<Exclude<Intent, "off_label" | "adverse_event" | "comparative" | "human_request" | "other">, string[]> = {
  dosing: ["dose", "dosing", "titration", "mg", "how much", "frequency"],
  safety: ["safety", "contraindicat", "warning", "isi", "risk", "side"],
  administration: ["administer", "injection", "infusion", "how to take", "route"],
  trial_data: ["trial", "study", "efficacy", "endpoint", "clinical data", "results"],
  access: ["coverage", "cost", "access", "insurance", "copay", "reimburs"],
  // Publicly-disclosable product facts (mechanism, program, status) — the ONLY
  // topics an investigational rep answers directly. GENERIC terms only; product/
  // program names come from the brand lexicon (configureClassifierLexicon).
  product_info: [
    "what is", "what's", "tell me about", "tell me more", "explain", "mechanism", "how does", "moa",
    "program", "indication", "investigational", "fast track", "development", "class of drug",
  ],
};

// Brand lexicon: product/program names contribute to product_info intent WITHOUT living
// in this generic engine file. The container configures this once from the BrandProfile,
// so onboarding a new brand never edits the classifier.
let PRODUCT_TERMS: string[] = [];
let PRODUCT_CANON: { despaced: string; display: string }[] = [];
export function configureClassifierLexicon(productTerms: string[]): void {
  PRODUCT_TERMS = productTerms.map((t) => t.toLowerCase().trim()).filter(Boolean);
  PRODUCT_CANON = PRODUCT_TERMS.map((t) => ({
    despaced: t.replace(/[^a-z0-9]/g, ""),
    display: t.replace(/\b\w/g, (c) => c.toUpperCase()),
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
  const repls: { start: number; end: number; display: string }[] = [];
  const used = new Array<boolean>(tokens.length).fill(false);
  for (const win of [1, 2]) {
    for (let i = 0; i + win <= tokens.length; i++) {
      if (used.slice(i, i + win).some(Boolean)) continue;
      const cand = norm(tokens.slice(i, i + win).map((t) => t.raw).join(""));
      if (cand.length < 4) continue;
      for (const term of PRODUCT_CANON) {
        if (term.despaced.length < 6 || cand === term.despaced) continue; // tiny terms + exact hits: leave alone
        const lcs = longestCommonSubstr(cand, term.despaced);
        if (lcs >= 6 && lcs >= Math.ceil(term.despaced.length * 0.6) && Math.abs(cand.length - term.despaced.length) <= 2) {
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

function hits(text: string, terms: string[]): number {
  return terms.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
}

export function classify(input: string): RiskClassification {
  const text = input.toLowerCase();

  const aeRisk = clamp(hits(text, AE_TERMS) * 0.6);
  const offLabelRisk = clamp(hits(text, OFF_LABEL_TERMS) * 0.7);
  const comparativeRisk = clamp(hits(text, COMPARATIVE_TERMS) * 0.7);
  const injectionRisk = clamp(hits(text, INJECTION_TERMS) * 0.8);
  const medicalInfoRisk = clamp(hits(text, MSL_TERMS) * 0.6);

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
