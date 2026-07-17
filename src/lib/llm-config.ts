/**
 * One source of truth for LLM provider config. The compliance CLASSIFIER (non-streaming JSON) and the
 * realtime RESPONDER (streaming SSE) are different call shapes, but they target the SAME providers —
 * previously each module re-declared the base-URL / key / model env reads, which drifted. They now
 * both build on these shared provider descriptors. Kept in @lib (not a module) so either module can
 * import it without a cross-module cycle.
 */

/** An OpenAI-compatible chat endpoint (OpenAI itself, or any compatible runtime via a base URL). */
export interface OpenAiCompatibleProvider {
  /** Stable id used to select the provider (e.g. from the model-lab). */
  name: string;
  baseUrl: () => string | undefined;
  apiKey: () => string | undefined;
  model: () => string;
}

export const OPENAI_PROVIDER: OpenAiCompatibleProvider = {
  name: "openai",
  baseUrl: () => process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey: () => process.env.OPENAI_API_KEY,
  model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
};

// Thinking Machines interaction models: no confirmed public LLM API (see docs/VENDOR_EVAL.md). If
// their runtime exposes an OpenAI-compatible endpoint, point THINKING_MACHINES_BASE_URL + _API_KEY at
// it and both the classifier and responder light up.
export const THINKING_MACHINES_PROVIDER: OpenAiCompatibleProvider = {
  name: "thinking-machines",
  baseUrl: () => process.env.THINKING_MACHINES_BASE_URL,
  apiKey: () => process.env.THINKING_MACHINES_API_KEY,
  model: () => process.env.THINKING_MACHINES_MODEL || "default",
};

/** Anthropic model — haiku for realtime turn-taking latency unless ANTHROPIC_MODEL overrides it. */
export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
}
