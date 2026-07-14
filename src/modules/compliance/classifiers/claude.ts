/**
 * Claude classifier (Anthropic SDK). Dynamically imported so the SDK never
 * enters a client bundle and only loads server-side when a key is configured.
 * Defaults to claude-haiku-4-5 for realtime latency; set ANTHROPIC_MODEL to a
 * larger model only when you intentionally accept slower turn-taking.
 */

import { CLASSIFIER_SYSTEM, parseClassification } from "./shared";
import type { LlmClassifier } from "./types";

function model(): string {
  return process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
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
      max_tokens: 512,
      system: CLASSIFIER_SYSTEM,
      messages: [
        { role: "user", content: text?.trim() || "(no message)" },
        // Prefill the reply with "{" so Claude MUST continue a JSON object and can never answer
        // conversationally. Without this it replied "I'm ready to help…" to the fragment "And",
        // which isn't JSON and silently dropped us to the keyword classifier. We re-attach the
        // brace before parsing (the prefill text is not echoed back in the response content).
        { role: "assistant", content: "{" },
      ],
    });
    const latencyMs = Date.now() - t0;
    const raw = `{${res.content.find((b) => b.type === "text")?.text ?? ""}`;
    return {
      result: parseClassification(raw),
      latencyMs,
      raw,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  },
};
