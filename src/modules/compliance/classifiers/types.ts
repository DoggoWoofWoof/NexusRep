import type { RiskClassification } from "../types";

export interface ClassifyOutcome {
  result: RiskClassification;
  latencyMs: number;
  /** Raw model output, for debugging in the compare view. */
  raw?: string;
  /** Token usage if the provider reports it. */
  usage?: { input?: number; output?: number };
}

/**
 * A swappable intent/risk classifier. `keyword` is deterministic and always
 * available; the others are real LLM calls that light up only when their API
 * key (and base URL, for OpenAI-compatible endpoints) is configured.
 */
export interface LlmClassifier {
  readonly name: string;
  readonly label: string;
  available(): boolean;
  classify(text: string): Promise<ClassifyOutcome>;
}
