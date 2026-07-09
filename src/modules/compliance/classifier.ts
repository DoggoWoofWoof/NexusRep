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
  // topics an investigational rep answers directly.
  product_info: [
    "what is", "mechanism", "how does", "moa", "factor xia", "fxia", "librexia",
    "program", "indication", "investigational", "fast track", "development", "class of drug",
  ],
};

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
      const score = hits(text, terms);
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
