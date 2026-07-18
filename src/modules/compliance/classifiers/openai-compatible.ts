/**
 * OpenAI-compatible chat classifier. Powers the OpenAI provider and any
 * OpenAI-compatible endpoint (e.g. a Thinking Machines interaction-model
 * runtime, a local server) via a configurable base URL. Uses raw fetch — no
 * extra SDK dependency.
 */

import { CLASSIFIER_SYSTEM, classifierMaxTokens, parseClassification } from "./shared";
import type { LlmClassifier } from "./types";
import { OPENAI_PROVIDER, THINKING_MACHINES_PROVIDER, type OpenAiCompatibleProvider } from "@lib/llm-config";
import { redactPii } from "@lib/pii-redact";

type CompatConfig = OpenAiCompatibleProvider & { label: string };

export function makeOpenAiCompatible(cfg: CompatConfig): LlmClassifier {
  return {
    name: cfg.name,
    get label() {
      return cfg.label;
    },
    available: () => Boolean(cfg.baseUrl()) && Boolean(cfg.apiKey()),
    async classify(text: string) {
      const baseUrl = cfg.baseUrl();
      const apiKey = cfg.apiKey();
      if (!baseUrl || !apiKey) throw new Error(`${cfg.name}: not configured`);

      const t0 = Date.now();
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.model(),
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM },
            // PII scrubbed before egress (keyword classification upstream still sees full text).
            { role: "user", content: redactPii(text) },
          ],
          response_format: { type: "json_object" },
          max_tokens: classifierMaxTokens(),
        }),
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) throw new Error(`${cfg.name}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      return {
        result: parseClassification(raw),
        latencyMs,
        raw,
        usage: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
      };
    },
  };
}

export const openaiClassifier = makeOpenAiCompatible({ ...OPENAI_PROVIDER, label: "OpenAI (chat)" });

export const thinkingMachinesClassifier = makeOpenAiCompatible({
  ...THINKING_MACHINES_PROVIDER,
  label: "Thinking Machines (OpenAI-compatible endpoint)",
});
