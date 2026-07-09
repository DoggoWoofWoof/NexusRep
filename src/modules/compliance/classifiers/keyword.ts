import { classify } from "../classifier";
import type { LlmClassifier } from "./types";

/** The deterministic keyword classifier — $0, offline, always available, fail-safe default. */
export const keywordClassifier: LlmClassifier = {
  name: "keyword",
  label: "Keyword (deterministic · $0)",
  available: () => true,
  async classify(text: string) {
    const t0 = Date.now();
    const result = classify(text);
    return { result, latencyMs: Date.now() - t0 };
  },
};
