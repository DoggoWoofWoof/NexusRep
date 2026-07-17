/**
 * Real streaming LLM responders. Claude via the Anthropic SDK's streaming
 * helper; OpenAI-compatible endpoints via raw fetch SSE. Both yield text deltas
 * the moment the model produces them — so the UI can speak as it generates and
 * the user can barge in. Available only when keys/base URLs are configured.
 */

import { env } from "@lib/env";
import { OPENAI_PROVIDER, THINKING_MACHINES_PROVIDER, anthropicModel, type OpenAiCompatibleProvider } from "@lib/llm-config";
import { RESPONDER_SYSTEM, type Responder } from "./types";

export const claudeResponder: Responder = {
  name: "claude",
  get label() {
    return `Claude (${anthropicModel()}, streaming)`;
  },
  available: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async *stream(prompt, signal) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const stream = client.messages.stream(
      {
        model: anthropicModel(),
        max_tokens: env.composerMaxTokens,
        system: RESPONDER_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      },
      { signal },
    );
    for await (const event of stream) {
      if (signal?.aborted) return;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  },
};

type CompatCfg = OpenAiCompatibleProvider & { label: string };

function makeOpenAiCompatibleResponder(cfg: CompatCfg): Responder {
  return {
    name: cfg.name,
    get label() {
      return cfg.label;
    },
    available: () => Boolean(cfg.baseUrl()) && Boolean(cfg.apiKey()),
    async *stream(prompt, signal) {
      const baseUrl = cfg.baseUrl();
      const apiKey = cfg.apiKey();
      if (!baseUrl || !apiKey) return;
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.model(),
          stream: true,
          max_tokens: env.composerMaxTokens,
          messages: [
            { role: "system", content: RESPONDER_SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`${cfg.name}: HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        if (signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            /* ignore keep-alive / partial */
          }
        }
      }
    },
  };
}

export const openaiResponder = makeOpenAiCompatibleResponder({ ...OPENAI_PROVIDER, label: "OpenAI (chat, streaming)" });

export const thinkingMachinesResponder = makeOpenAiCompatibleResponder({
  ...THINKING_MACHINES_PROVIDER,
  label: "Thinking Machines (OpenAI-compatible endpoint, streaming)",
});
