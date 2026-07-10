/**
 * Classifier registry + selection. The conversation uses one provider
 * (env-selected, fail-safe to keyword); the compare view runs them all.
 */

import { env } from "@lib/env";
import { classify } from "../classifier";
import type { RiskClassification } from "../types";
import { keywordClassifier } from "./keyword";
import { claudeClassifier } from "./claude";
import { openaiClassifier, thinkingMachinesClassifier } from "./openai-compatible";
import type { LlmClassifier } from "./types";

export type { LlmClassifier, ClassifyOutcome } from "./types";

export const CLASSIFIERS: LlmClassifier[] = [
  keywordClassifier,
  claudeClassifier,
  openaiClassifier,
  thinkingMachinesClassifier,
];

export function getClassifier(name: string): LlmClassifier | undefined {
  return CLASSIFIERS.find((c) => c.name === name);
}

/** Classify with a named provider, failing safe to the keyword classifier. */
export async function classifyWith(name: string, text: string): Promise<RiskClassification> {
  const c = getClassifier(name);
  if (!c || c.name === "keyword" || !c.available()) return classify(text);
  try {
    return mergeWithKeywordSignals((await c.classify(text)).result, classify(text));
  } catch {
    return classify(text);
  }
}

export interface ProviderComparison {
  name: string;
  label: string;
  available: boolean;
  result?: RiskClassification;
  latencyMs?: number;
  usage?: { input?: number; output?: number };
  error?: string;
}

/** Run one input through every classifier (available ones in parallel). For the /compare view. */
export async function compareClassifiers(text: string): Promise<ProviderComparison[]> {
  return Promise.all(
    CLASSIFIERS.map(async (c): Promise<ProviderComparison> => {
      if (!c.available()) return { name: c.name, label: c.label, available: false };
      try {
        const out = await c.classify(text);
        return { name: c.name, label: c.label, available: true, result: out.result, latencyMs: out.latencyMs, usage: out.usage };
      } catch (e) {
        return { name: c.name, label: c.label, available: true, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

/**
 * The classifier the live conversation uses. Picks the env-selected provider;
 * on any error or if it's unavailable, FAILS SAFE to the deterministic keyword
 * classifier (a conservative, always-available baseline).
 */
export function resolveClassifier(): (text: string) => Promise<RiskClassification> {
  const chosen = getClassifier(env.classifierProvider);
  return async (text: string) => {
    const keyword = classify(text);
    if (!chosen || chosen.name === "keyword" || !chosen.available()) return keyword;
    try {
      return mergeWithKeywordSignals((await chosen.classify(text)).result, keyword);
    } catch (e) {
      console.warn(`[classifier] ${chosen.name} failed, falling back to keyword:`, e);
      return keyword;
    }
  };
}

function hasHighSafetyRisk(c: RiskClassification): boolean {
  return (
    c.offLabelRisk >= 0.6 ||
    c.adverseEventRisk >= 0.6 ||
    c.promptInjectionRisk >= 0.6 ||
    c.comparativeClaimRisk >= 0.6
  );
}

/**
 * LLMs are better at nuance, but they can false-negative short mechanism/program
 * follow-ups after a broad overview. Keep the LLM label when it is specific, but
 * always merge deterministic risk scores and recover obvious product-info /
 * human-handoff intents when no safety risk is present.
 */
export function mergeWithKeywordSignals(llm: RiskClassification, keyword: RiskClassification): RiskClassification {
  const merged: RiskClassification = {
    ...llm,
    offLabelRisk: Math.max(llm.offLabelRisk, keyword.offLabelRisk),
    adverseEventRisk: Math.max(llm.adverseEventRisk, keyword.adverseEventRisk),
    medicalInfoRisk: Math.max(llm.medicalInfoRisk, keyword.medicalInfoRisk),
    promptInjectionRisk: Math.max(llm.promptInjectionRisk, keyword.promptInjectionRisk),
    comparativeClaimRisk: Math.max(llm.comparativeClaimRisk, keyword.comparativeClaimRisk),
    isiRequired: llm.isiRequired || keyword.isiRequired,
  };

  if (!hasHighSafetyRisk(merged) && keyword.intent === "human_request") {
    return { ...merged, intent: "human_request", confidence: Math.max(merged.confidence, keyword.confidence), isiRequired: false };
  }

  if (!hasHighSafetyRisk(merged) && keyword.intent === "product_info" && keyword.confidence >= 0.7) {
    // Recovery exists for LLM FAILURES (low-confidence "other" fallbacks) — the keyword
    // lexicon recognizing the drug name must never lower a CONFIDENT LLM's deliberate
    // medical-information escalation, or deep clinical questions get answered directly
    // instead of routed to Medical Information.
    const llmUnreliable = merged.intent === "other" || merged.confidence < 0.6;
    if (llmUnreliable) {
      return { ...merged, medicalInfoRisk: Math.min(merged.medicalInfoRisk, 0.3), intent: "product_info", confidence: Math.max(merged.confidence, keyword.confidence), isiRequired: true };
    }
    return merged;
  }

  return merged;
}
