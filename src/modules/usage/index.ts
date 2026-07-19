/**
 * Vendor usage & cost ledger — the per-session, in-process record of every PAID vendor call the
 * runtime makes: Claude/OpenAI classifier + composer tokens, OpenAI TTS characters, Tavus video
 * seconds. Mirrors RuntimeMetrics (process-cheap, capped, per-container) but keeps enough detail to
 * answer "what did THIS conversation cost, broken down by vendor?".
 *
 * Token/char/second COUNTS are exact (reported by the vendor). The dollar figure is an ESTIMATE laid
 * on top from the PRICES table below — treat it as a directional cost signal, not an invoice. Prices
 * are editable in one place and overridable via env for when a contract rate differs from list.
 *
 * In-memory + capped (resets on restart, like RuntimeMetrics + the activity log) — behind this small
 * surface so a durable store (Postgres) can replace the buffer later without touching a caller. Ties
 * to the same managed-Postgres step as durable sessions/activity.
 */

export type UsageVendor = "anthropic" | "openai" | "tavus" | "elevenlabs" | "other";

/** What the spend was for — so a session's cost splits into understandable lines. */
export type UsageOperation =
  | "classify" // intent/risk classifier LLM
  | "compose" // grounded answer generation LLM
  | "setup" // setup-assistant / rule-compaction helper LLM (non-runtime)
  | "tts" // text-to-speech (OpenAI / ElevenLabs)
  | "asr" // speech-to-text
  | "video"; // Tavus conversational video minutes

export interface UsageEvent {
  id: string;
  at: string; // ISO
  /** The conversation this spend belongs to, when known (TTS/among others may lack one). */
  sessionId?: string;
  /** The brand user / tenant whose container made the call — per-user cost attribution. */
  owner?: string;
  vendor: UsageVendor;
  operation: UsageOperation;
  /** Concrete model/engine, e.g. "claude-haiku-4-5", "gpt-4o-mini", "tts-1", "tavus-cvi". */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Billable characters (TTS bills per character, not token). */
  chars?: number;
  /** Billable seconds of media (Tavus video / ASR audio). */
  seconds?: number;
  /** Estimated USD for this single event (from PRICES). */
  estCostUsd: number;
}

export type UsageInput = Omit<UsageEvent, "id" | "at" | "estCostUsd">;

/**
 * List-price estimates (USD). Per-million for tokens/chars; per-minute for video. These are
 * ESTIMATES for a directional cost signal — override a rate via the env var noted, or edit here when
 * a model or contract changes. Unknown model → cost 0 (the raw counts are still recorded).
 */
export interface Rate {
  inPerMTok?: number;
  outPerMTok?: number;
  perMChars?: number;
  perMinute?: number;
}

/** Keyed by a normalized model id (see priceKey). Kept small + explicit on purpose. */
export const PRICES: Record<string, Rate> = {
  // Anthropic (Claude). Haiku is the realtime default; Sonnet/Opus if an operator overrides the model.
  "claude-haiku-4-5": { inPerMTok: 1.0, outPerMTok: 5.0 },
  "claude-sonnet-5": { inPerMTok: 3.0, outPerMTok: 15.0 },
  "claude-opus-4-8": { inPerMTok: 15.0, outPerMTok: 75.0 },
  // OpenAI (chat).
  "gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6 },
  "gpt-4o": { inPerMTok: 2.5, outPerMTok: 10.0 },
  // OpenAI TTS (billed per character).
  "tts-1": { perMChars: 15.0 },
  "tts-1-hd": { perMChars: 30.0 },
  "gpt-4o-mini-tts": { perMChars: 12.0 },
  // Tavus conversational video (billed per minute of live conversation) — estimate.
  "tavus-cvi": { perMinute: 0.3 },
};

const envNum = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
};

/** Which vendor bills a given model — so a raw model string lands under the right vendor total. */
export function vendorForModel(model?: string): UsageVendor {
  const m = (model ?? "").toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("tts") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.startsWith("tavus")) return "tavus";
  if (m.includes("eleven")) return "elevenlabs";
  return "other";
}

/** Normalize a raw model string to a PRICES key (strip date suffixes, lowercase). */
export function priceKey(model?: string): string {
  const m = (model ?? "").toLowerCase().trim();
  if (!m) return "";
  if (m.startsWith("claude-haiku")) return "claude-haiku-4-5";
  if (m.startsWith("claude-sonnet")) return "claude-sonnet-5";
  if (m.startsWith("claude-opus")) return "claude-opus-4-8";
  // TTS models must be matched BEFORE the chat models (gpt-4o-mini-tts starts with gpt-4o-mini).
  if (m.includes("tts")) {
    if (m.includes("mini")) return "gpt-4o-mini-tts";
    if (m.includes("hd")) return "tts-1-hd";
    return "tts-1";
  }
  if (m.startsWith("gpt-4o-mini")) return "gpt-4o-mini";
  if (m.startsWith("gpt-4o")) return "gpt-4o";
  if (m.startsWith("tavus")) return "tavus-cvi";
  return m;
}

/** Estimate USD for one usage record. Missing rate → 0 (counts are still kept). */
export function estimateCostUsd(input: UsageInput): number {
  const rate = PRICES[priceKey(input.model)] ?? {};
  // Per-operation env overrides for the common runtime models (contract rates differ from list).
  const inRate = input.operation === "compose" ? envNum("NEXUSREP_PRICE_COMPOSE_IN_PER_MTOK") ?? rate.inPerMTok : rate.inPerMTok;
  const outRate = input.operation === "compose" ? envNum("NEXUSREP_PRICE_COMPOSE_OUT_PER_MTOK") ?? rate.outPerMTok : rate.outPerMTok;
  let usd = 0;
  if (input.inputTokens && inRate) usd += (input.inputTokens / 1_000_000) * inRate;
  if (input.outputTokens && outRate) usd += (input.outputTokens / 1_000_000) * outRate;
  if (input.chars && rate.perMChars) usd += (input.chars / 1_000_000) * rate.perMChars;
  if (input.seconds && rate.perMinute) usd += (input.seconds / 60) * rate.perMinute;
  return usd;
}

/** A per-vendor / per-operation rollup line. */
export interface UsageRollup {
  vendor: UsageVendor;
  operation: UsageOperation;
  model?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  chars: number;
  seconds: number;
  estCostUsd: number;
}

export interface UsageSummary {
  events: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byVendor: Record<string, number>; // vendor -> est USD
  byOperation: Record<string, number>; // operation -> est USD
  byUser: Record<string, number>; // owner -> est USD
  rollups: UsageRollup[]; // grouped detail, highest cost first
}

function rollupKey(e: UsageEvent): string {
  return `${e.vendor}|${e.operation}|${e.model ?? ""}`;
}

function summarize(events: UsageEvent[]): UsageSummary {
  const byVendor: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  const byUser: Record<string, number> = {};
  const groups = new Map<string, UsageRollup>();
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const e of events) {
    totalCostUsd += e.estCostUsd;
    totalInputTokens += e.inputTokens ?? 0;
    totalOutputTokens += e.outputTokens ?? 0;
    byVendor[e.vendor] = (byVendor[e.vendor] ?? 0) + e.estCostUsd;
    byOperation[e.operation] = (byOperation[e.operation] ?? 0) + e.estCostUsd;
    byUser[e.owner ?? "unknown"] = (byUser[e.owner ?? "unknown"] ?? 0) + e.estCostUsd;
    const key = rollupKey(e);
    const g = groups.get(key) ?? { vendor: e.vendor, operation: e.operation, model: e.model, requests: 0, inputTokens: 0, outputTokens: 0, chars: 0, seconds: 0, estCostUsd: 0 };
    g.requests += 1;
    g.inputTokens += e.inputTokens ?? 0;
    g.outputTokens += e.outputTokens ?? 0;
    g.chars += e.chars ?? 0;
    g.seconds += e.seconds ?? 0;
    g.estCostUsd += e.estCostUsd;
    groups.set(key, g);
  }
  const rollups = [...groups.values()].sort((a, b) => b.estCostUsd - a.estCostUsd || b.requests - a.requests);
  return { events: events.length, totalCostUsd, totalInputTokens, totalOutputTokens, byVendor, byOperation, byUser, rollups };
}

const MAX_EVENTS = 5000; // bound memory; oldest fall off (live monitoring, not archival billing)

/**
 * Per-container usage ledger. record() is the single write path; it never throws (observability must
 * not break the flow it observes) and stamps the estimated cost so callers stay simple.
 */
export class UsageLedger {
  private events: UsageEvent[] = [];
  private seq = 0;

  /** Record one vendor call. Skips truly empty records (no tokens/chars/seconds) to avoid noise. */
  record(input: UsageInput): UsageEvent | null {
    try {
      if (!input.inputTokens && !input.outputTokens && !input.chars && !input.seconds) return null;
      const seq = ++this.seq;
      const event: UsageEvent = {
        id: `use_${seq.toString(36)}`,
        at: new Date().toISOString(),
        estCostUsd: estimateCostUsd(input),
        ...input,
      };
      this.events.push(event);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      return event;
    } catch {
      return null;
    }
  }

  /** All events for one session, oldest first. */
  forSession(sessionId: string): UsageEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  /** Cost + detail rollup for one session. */
  sessionSummary(sessionId: string): UsageSummary {
    return summarize(this.forSession(sessionId));
  }

  /** Cost + detail rollup across everything retained. */
  summary(): UsageSummary {
    return summarize(this.events);
  }

  /** Per-session cost totals (highest first) for the admin overview. */
  perSession(limit = 100): { sessionId: string; events: number; estCostUsd: number }[] {
    const totals = new Map<string, { events: number; estCostUsd: number }>();
    for (const e of this.events) {
      if (!e.sessionId) continue;
      const t = totals.get(e.sessionId) ?? { events: 0, estCostUsd: 0 };
      t.events += 1;
      t.estCostUsd += e.estCostUsd;
      totals.set(e.sessionId, t);
    }
    return [...totals.entries()]
      .map(([sessionId, t]) => ({ sessionId, ...t }))
      .sort((a, b) => b.estCostUsd - a.estCostUsd)
      .slice(0, limit);
  }

  /** Per-user (owner) cost totals, highest first — the per-user attribution the admin view needs. */
  perUser(limit = 100): { owner: string; events: number; estCostUsd: number }[] {
    const totals = new Map<string, { events: number; estCostUsd: number }>();
    for (const e of this.events) {
      const owner = e.owner ?? "unknown";
      const t = totals.get(owner) ?? { events: 0, estCostUsd: 0 };
      t.events += 1;
      t.estCostUsd += e.estCostUsd;
      totals.set(owner, t);
    }
    return [...totals.entries()]
      .map(([owner, t]) => ({ owner, ...t }))
      .sort((a, b) => b.estCostUsd - a.estCostUsd)
      .slice(0, limit);
  }

  /** Daily buckets (UTC), oldest first, each carrying a running cumulative cost — for the trend graph.
   *  Optionally scoped to one owner so the dashboard can chart a single user. */
  perDay(opts?: { owner?: string }): { date: string; events: number; estCostUsd: number; inputTokens: number; outputTokens: number; chars: number; seconds: number; cumulativeCostUsd: number }[] {
    const src = opts?.owner ? this.events.filter((e) => (e.owner ?? "unknown") === opts.owner) : this.events;
    const days = new Map<string, { events: number; estCostUsd: number; inputTokens: number; outputTokens: number; chars: number; seconds: number }>();
    for (const e of src) {
      const date = e.at.slice(0, 10); // YYYY-MM-DD from the ISO timestamp (UTC)
      const d = days.get(date) ?? { events: 0, estCostUsd: 0, inputTokens: 0, outputTokens: 0, chars: 0, seconds: 0 };
      d.events += 1;
      d.estCostUsd += e.estCostUsd;
      d.inputTokens += e.inputTokens ?? 0;
      d.outputTokens += e.outputTokens ?? 0;
      d.chars += e.chars ?? 0;
      d.seconds += e.seconds ?? 0;
      days.set(date, d);
    }
    let cumulativeCostUsd = 0;
    return [...days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, d]) => {
        cumulativeCostUsd += d.estCostUsd;
        return { date, ...d, cumulativeCostUsd };
      });
  }

  /** Most-recent events (newest first) for a live feed. */
  recent(limit = 200): UsageEvent[] {
    return this.events.slice(-limit).reverse();
  }

  /** Snapshot every retained event — for durable persistence (see lib/ledger-persistence.ts). */
  dumpEvents(): UsageEvent[] {
    return this.events.slice();
  }

  /** Restore events from a persisted snapshot at boot. Only fills an EMPTY ledger, so a live event
   *  recorded before hydrate completes is never clobbered (first-write-wins). */
  loadEvents(events: UsageEvent[]): void {
    if (this.events.length || !Array.isArray(events) || !events.length) return;
    this.events = events.slice(-MAX_EVENTS);
    this.seq = this.events.length; // keep new ids monotonic; collisions are benign (id isn't a key)
  }

  /** Test-only reset so cases don't bleed into each other. */
  __reset(): void {
    this.events = [];
    this.seq = 0;
  }
}

// Process-global ledger. Usage is a cross-tenant admin-observability concern on a single-instance
// deploy (render numInstances:1) — like the activity log — so ONE ledger backs every container and the
// admin usage view, instead of a per-container ledger the admin surface would have to merge.
const g = globalThis as unknown as { __nexusrepUsage?: UsageLedger };
export function getUsageLedger(): UsageLedger {
  if (!g.__nexusrepUsage) g.__nexusrepUsage = new UsageLedger();
  return g.__nexusrepUsage;
}
