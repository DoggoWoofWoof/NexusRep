/**
 * Grounded answer composer. An LLM writes the rep's reply USING ONLY the
 * retrieved approved blocks — it may rephrase/synthesize, but must not introduce
 * any fact, number, claim, comparison, or recommendation not in those blocks.
 * ISI is delivered verbatim by the orchestrator (never paraphrased here), and
 * the compliance gate still validates grounding before output.
 *
 * Dynamically imports the Anthropic SDK so it stays server-side and loads only
 * when a key is configured. OpenAI-compatible endpoints go through fetch.
 */

import { env } from "@lib/env";
import type { ApprovedAnswer } from "./types";

export const COMPOSER_SYSTEM = `You are an AI pharmaceutical representative answering a healthcare professional (HCP).

Rules — these are absolute:
- Use ONLY the approved content and required safety information provided below. You may rephrase, reorder, combine, and emphasize it into ONE natural answer, but do NOT add any fact, dose, number, statistic, efficacy/safety/comparative claim, or recommendation that is not explicitly present in it.
- If the provided content does not answer the question, say you can connect them with a representative or medical information — do not guess or generalize.
- Do NOT mention "approved content", sources, MLR, or internal systems.
- The question is TRANSCRIBED FROM SPEECH and may be garbled or misspelled — especially the product/program name ("Millivaxian", "Librix", "mil vaccine"). Charitably infer the most likely intended question about THIS product and answer it directly. Only ask for clarification if the message is truly unintelligible; do not bounce a recoverable question.
- Do NOT introduce yourself or say you are an AI representative in the answer body. The greeting/disclosure already handles that.
- Answer the SPECIFIC thing asked and keep it fresh: vary your wording and framing turn to turn. Restating an important or directly-relevant point is fine — just say it in DIFFERENT words, not the same sentences. What reads robotic is padding every reply with the same background (program name, the three indications, drug class) when it isn't the answer; lead with what's new and reference background briefly only when it helps.
- Do NOT write, paraphrase, shorten, or summarize Important Safety Information. The platform appends the exact required ISI after your answer when needed.
- Return only the answer body. Do not include an "Important Safety Information" heading or block.
- This answer is SPOKEN aloud by a video rep, so be brief and conversational: lead with the single most relevant point and, unless the brand coaching below says otherwise, keep it to 1–2 short sentences (roughly 40 words). A long reply takes many seconds to speak and makes the doctor wait; if there is more to cover, say one line and offer to go deeper. Follow the brand coaching for tone and emphasis.
- Write for the EAR. Use commas and periods for pauses. Do NOT use dash punctuation (no em dashes, en dashes, or " -- ") and no markdown — a text-to-speech voice reads a dash as an awkward hard stop. Ordinary hyphenated words ("Fast-Track", "on-label") are fine.`;

export interface ComposeInput {
  question: string;
  blocks: ApprovedAnswer[];
  /**
   * Optional brand COACHING (tone / length / emphasis only). It is layered UNDER the absolute
   * rules above — it can change how the approved content is phrased, which approved point leads,
   * and the tone, but it can never introduce a new fact/number/claim or override grounding.
   * Grounding validation + the compliance gate still run after composition.
   */
  guidance?: string[];
  /**
   * Required safety information (ISI) the answer MUST NOT rewrite. This text is provided only so
   * the composer knows not to duplicate it; the orchestrator appends it verbatim and the final gate
   * checks the exact text is present.
   */
  safety?: string;
  /** True once the AI/investigational disclosure has been given this session — the answer
   *  must not restate it (a rep who re-introduces themselves every reply reads as canned). */
  alreadyDisclosed?: boolean;
  /** Optional per-call generation budget. Live voice uses a smaller budget than coaching drafts. */
  maxTokens?: number;
}

/** Build the composer system prompt: absolute rules + approved blocks + required safety + coaching. */
function systemFor(blocks: ApprovedAnswer[], guidance?: string[], safety?: string, alreadyDisclosed?: boolean): string {
  const notes = (guidance ?? []).map((g) => g.trim()).filter(Boolean);
  const hardLength = lengthConstraint(notes);
  const coaching = notes.length
    ? `\n\nBrand coaching (tone / length / emphasis — never overrides the absolute rules above and never adds facts):\n${notes.map((g) => `- ${g}`).join("\n")}${hardLength}`
    : "";
  const safe = safety?.trim()
    ? `\n\nImportant Safety Information that the platform will append EXACTLY after your answer. Do not paraphrase, shorten, summarize, or duplicate it in your response. Because it will appear immediately after your answer, avoid restating its standalone not-approved / safety-and-efficacy / Medical-Information-routing points in the body unless the HCP specifically asks for safety information:\n${safety.trim()}`
    : "";
  const disclosed = alreadyDisclosed
    ? "\n\nThe greeting/disclosure and the investigational / not-FDA-approved status were ALREADY stated earlier in this conversation. Do NOT restate either - answer the question directly."
    : "";
  return `${COMPOSER_SYSTEM}\n\nApproved content:\n${blocksText(blocks)}${safe}${disclosed}${coaching}`;
}

function lengthConstraint(notes: string[]): string {
  const joined = notes.join("\n").toLowerCase();
  if (/\b(?:one|1|single)[ -]?sentence\b/.test(joined)) {
    return "\nHard length constraint: the answer body must be exactly one sentence before any platform-appended ISI.";
  }
  if (/\b(?:two|2)[ -]?sentences?\b/.test(joined)) {
    return "\nHard length constraint: the answer body must be no more than two sentences before any platform-appended ISI.";
  }
  if (/\b(?:shorter|brief|concise|succinct|under \d+ words?|less detail|keep .* short|keep .* brief)\b/.test(joined)) {
    return "\nHard length constraint: keep the answer body concise, usually one or two sentences before any platform-appended ISI.";
  }
  return "";
}

export interface GroundedComposer {
  readonly name: string;
  available(): boolean;
  compose(input: ComposeInput): Promise<{ text: string; latencyMs: number; truncated?: boolean }>;
}

function blocksText(blocks: ApprovedAnswer[]): string {
  return blocks.map((b, i) => `[${i + 1}] (${b.topic}) ${b.text}`).join("\n");
}

function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
}

const claudeComposer: GroundedComposer = {
  name: "claude",
  available: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async compose({ question, blocks, guidance, safety, alreadyDisclosed, maxTokens }) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const t0 = Date.now();
    const res = await client.messages.create({
      model: anthropicModel(),
      max_tokens: maxTokens ?? env.composerMaxTokens,
      system: systemFor(blocks, guidance, safety, alreadyDisclosed),
      messages: [{ role: "user", content: question }],
    });
    const text = res.content.find((b) => b.type === "text")?.text ?? "";
    return { text, latencyMs: Date.now() - t0, truncated: res.stop_reason === "max_tokens" };
  },
};

interface CompatCfg { name: string; baseUrl: () => string | undefined; apiKey: () => string | undefined; model: () => string }

function makeOpenAiCompatibleComposer(cfg: CompatCfg): GroundedComposer {
  return {
    name: cfg.name,
    available: () => Boolean(cfg.baseUrl()) && Boolean(cfg.apiKey()),
    async compose({ question, blocks, guidance, safety, alreadyDisclosed, maxTokens }) {
      const baseUrl = cfg.baseUrl();
      const apiKey = cfg.apiKey();
      if (!baseUrl || !apiKey) throw new Error(`${cfg.name}: not configured`);
      const t0 = Date.now();
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.model(),
          max_tokens: maxTokens ?? env.composerMaxTokens,
          messages: [
            { role: "system", content: systemFor(blocks, guidance, safety, alreadyDisclosed) },
            { role: "user", content: question },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${cfg.name}: HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
      const choice = data.choices?.[0];
      return { text: choice?.message?.content ?? "", latencyMs: Date.now() - t0, truncated: choice?.finish_reason === "length" };
    },
  };
}

const openaiComposer = makeOpenAiCompatibleComposer({
  name: "openai",
  baseUrl: () => process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey: () => process.env.OPENAI_API_KEY,
  model: () => process.env.OPENAI_MODEL || "gpt-4o-mini",
});

const thinkingMachinesComposer = makeOpenAiCompatibleComposer({
  name: "thinking-machines",
  baseUrl: () => process.env.THINKING_MACHINES_BASE_URL,
  apiKey: () => process.env.THINKING_MACHINES_API_KEY,
  model: () => process.env.THINKING_MACHINES_MODEL || "default",
});

const COMPOSERS: GroundedComposer[] = [claudeComposer, openaiComposer, thinkingMachinesComposer];

export function getComposer(name: string): GroundedComposer | undefined {
  return COMPOSERS.find((c) => c.name === name);
}

/**
 * Low-level one-shot LLM text call — Claude if configured, else an OpenAI-compatible endpoint,
 * else null (no key). Used for the coaching helpers below (greeting rewrite + rule compaction),
 * which are NOT grounded answers, so they don't go through the block-based composer.
 */
/** Generic one-shot LLM text call (Claude → OpenAI-compatible → null when no key). Exported
 *  for NON-grounded helpers only (setup inference, rule compaction) — grounded rep answers
 *  always go through the block-based composers above. */
export async function llmComplete(system: string, user: string): Promise<string | null> {
  return llmText(system, user);
}

async function llmText(system: string, user: string): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const res = await client.messages.create({ model: anthropicModel(), max_tokens: env.composerMaxTokens, system, messages: [{ role: "user", content: user }] });
    return res.content.find((b) => b.type === "text")?.text ?? "";
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", max_tokens: env.composerMaxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
  return null;
}

/**
 * Rewrite the rep's OPENING GREETING per coaching (tone/length/emphasis), while REQUIRING the
 * mandatory disclosures stay in. The caller re-validates the disclosures deterministically and
 * fails safe to the current greeting if any are missing. usedLlm=false → no key (unchanged text).
 */
export async function composeGreeting(input: { current: string; coaching: string[]; investigational: boolean }): Promise<{ text: string; usedLlm: boolean }> {
  const notes = input.coaching.map((c) => c.trim()).filter(Boolean);
  const system = `You rewrite the OPENING GREETING an AI pharmaceutical representative says to a doctor.
The rewritten greeting MUST keep ALL of these (they are non-negotiable):
- Clearly disclose it is an AI representative (not a human).
${input.investigational ? "- State the product is investigational and not FDA-approved.\n" : ""}- Offer to connect the doctor with Medical Information for any clinical question.
Keep it to 1–2 sentences, professional, with NO medical/efficacy/safety claims.`;
  const user = `Current greeting:\n"${input.current}"\n\nApply this coaching (style/tone only — do not drop any required disclosure):\n${notes.map((n) => `- ${n}`).join("\n")}\n\nReturn ONLY the new greeting text, no quotes or preamble.`;
  const out = await llmText(system, user).catch(() => null);
  const text = (out ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return text ? { text, usedLlm: true } : { text: input.current, usedLlm: false };
}

/**
 * Compact several style-coaching notes into ONE concise directive plus a short EXAMPLE (one-shot),
 * so accepting a coached answer produces a single readable rule instead of many. Style/emphasis
 * only — never a medical claim (compliance-sensitive notes are handled as their own gated rules,
 * never routed through here). Falls back to joining the notes when no LLM key is configured.
 */
/** Strip markdown so a rule reads as a plain system-prompt directive (the way the Tavus persona
 *  and our composer consume it) — no **bold**, headers, backticks, or bullet glyphs. */
function plainDirective(s: string): string {
  return s
    .replace(/\*\*|__|`+/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*(directive|rule)\s*:\s*/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, " ")
    .trim();
}

export async function compactCoaching(notes: string[], ctx: { question: string; answer: string }): Promise<{ instruction: string; usedLlm: boolean }> {
  const clean = notes.map((n) => n.trim()).filter(Boolean);
  // Example = the accepted answer's prose, with the verbatim ISI block trimmed off, capped.
  const example = (ctx.answer.split(/\n\nImportant Safety Information:/)[0] ?? ctx.answer).trim().slice(0, 280);
  const fallback = plainDirective(`${clean.join("; ")}${clean.length ? "." : ""}${example ? ` For example, when asked "${ctx.question}", answer in this style: "${example}"` : ""}`);
  // Write the rule the way the rep's system prompt consumes it: a single plain-text imperative
  // directive + one example line. No markdown (it renders literally in the Rules list / prompt).
  const system = `You compress a brand's coaching notes into ONE rule for an AI pharma rep's system prompt. Rules: style/tone/emphasis ONLY — never a medical, dosing, efficacy, safety, or comparative claim, and never invent facts. Output PLAIN TEXT ONLY — no markdown, asterisks, headers, or bullet characters. Write one imperative directive (1–2 sentences) telling the rep how to speak, then a final line beginning "Example:" that shows the desired style using the accepted answer.`;
  const user = `Coaching notes:\n${clean.map((n) => `- ${n}`).join("\n")}\n\nQuestion asked: "${ctx.question}"\nAccepted answer in the desired style: "${example}"\n\nReturn the directive then the Example line, plain text.`;
  const out = await llmText(system, user).catch(() => null);
  const text = plainDirective(out ?? "");
  return text ? { instruction: text, usedLlm: true } : { instruction: fallback, usedLlm: false };
}

/** The composer the live conversation uses (env-selected). null = use the deterministic builder. */
export function resolveComposer(providerName: string): GroundedComposer | null {
  const c = getComposer(providerName);
  return c && c.available() ? c : null;
}

/** First composer with a configured key (claude → openai → thinking-machines), else null.
 *  Needed when compose mode is "llm" but the classifier is the keyword engine, which has
 *  no composer of its own — previously that combination silently stayed deterministic. */
export function firstAvailableComposer(): GroundedComposer | null {
  for (const c of COMPOSERS) if (c.available()) return c;
  return null;
}

/**
 * The composer the runtime should use by default: the classifier provider's own composer when it
 * has one, else the first with a key — UNLESS compose mode is forced to "deterministic". This is
 * the single source of truth so the live turn path AND the presentation walkthrough make the same
 * choice (both LLM-compose from the KB when a key is present, both verbatim when not). Returns null
 * → deterministic verbatim. env.composeMode already auto-selects "llm" when a provider key exists.
 */
export function defaultComposer(): GroundedComposer | null {
  if (env.composeMode === "deterministic") return null;
  return resolveComposer(env.classifierProvider) ?? firstAvailableComposer();
}
