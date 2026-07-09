/**
 * Claude classifier (Anthropic SDK). Dynamically imported so the SDK never
 * enters a client bundle and only loads server-side when a key is configured.
 * Defaults to claude-opus-4-8; set ANTHROPIC_MODEL=claude-haiku-4-5 for a
 * cheaper/faster classifier.
 */

import { CLASSIFIER_SYSTEM, parseClassification } from "./shared";
import type { LlmClassifier } from "./types";

function model(): string {
  return process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
}

export const claudeClassifier: LlmClassifier = {
  name: "claude",
  get label() {
    return `Claude (${model()})`;
  },
  available: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async classify(text: string) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const t0 = Date.now();
    const res = await client.messages.create({
      model: model(),
      max_tokens: 1024,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: text }],
    });
    const latencyMs = Date.now() - t0;
    const raw = res.content.find((b) => b.type === "text")?.text ?? "";
    return {
      result: parseClassification(raw),
      latencyMs,
      raw,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  },
};
