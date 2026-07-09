/**
 * OpenAI-compatible chat classifier. Powers the OpenAI provider and any
 * OpenAI-compatible endpoint (e.g. a Thinking Machines interaction-model
 * runtime, a local server) via a configurable base URL. Uses raw fetch — no
 * extra SDK dependency.
 */

import { CLASSIFIER_SYSTEM, parseClassification } from "./shared";
import type { LlmClassifier } from "./types";

interface CompatConfig {
  name: string;
  label: string;
  baseUrl: () => string | undefined;
  apiKey: () => string | undefined;
  model: () => string;
}

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
            { role: "user", content: text },
          ],
          response_format: { type: "json_object" },
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

export const openaiClassifier = makeOpenAiCompatible({
  name: "openai",
  label: "OpenAI (chat)",
  baseUrl: () => process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey: () => process.env.OPENAI_API_KEY,
  model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
});

// Thinking Machines interaction models: no confirmed public LLM API (see
// docs/VENDOR_EVAL.md). If their runtime exposes an OpenAI-compatible endpoint,
// point THINKING_MACHINES_BASE_URL + _API_KEY at it and this lights up.
export const thinkingMachinesClassifier = makeOpenAiCompatible({
  name: "thinking-machines",
  label: "Thinking Machines (OpenAI-compatible endpoint)",
  baseUrl: () => process.env.THINKING_MACHINES_BASE_URL,
  apiKey: () => process.env.THINKING_MACHINES_API_KEY,
  model: () => process.env.THINKING_MACHINES_MODEL || "default",
});
