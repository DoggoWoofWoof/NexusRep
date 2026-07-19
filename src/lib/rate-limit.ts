/**
 * In-process token-bucket rate limiter for the PUBLIC (unauthenticated) endpoints — the doctor
 * runtime path + the paid-vendor proxies (OpenAI TTS, Tavus session start, LLM turns). A module-level
 * Map is the right tool here: render.yaml pins numInstances: 1 (per-process state is already the
 * model — see active-call.ts), and these endpoints have no auth key to gate on.
 *
 * Buckets refill continuously; a request consumes one token or gets 429 + Retry-After. Limits are
 * GENEROUS (normal conversational cadence never trips them) — the point is to cap scripted abuse that
 * would burn LLM/TTS credits or spam Tavus session creation, not to throttle a real doctor.
 */

import { NextResponse } from "next/server";
import { env } from "@lib/env";

export interface LimitConfig {
  /** Max burst (bucket size). */
  readonly capacity: number;
  /** Sustained tokens added per second. */
  readonly refillPerSec: number;
}

/** Named per-endpoint limits, centralized so they're tunable + documented in one place. */
export const LIMITS = {
  /** OpenAI TTS proxy — paid per uncached text; an attacker varying `text` forces a call each time. */
  tts: { capacity: 30, refillPerSec: 1 },
  /** Typed doctor turn → full orchestrator (paid classifier + composer LLM). */
  llmTurn: { capacity: 30, refillPerSec: 1 },
  /** Guided presentation step/overview (retrieval + possible LLM per segment). */
  presentation: { capacity: 30, refillPerSec: 1 },
  /** Starting a LIVE Tavus CVI session — the most expensive call (paid video). Rare per visit. */
  startCall: { capacity: 5, refillPerSec: 0.05 },
  /** Tavus custom-LLM callback — keyed by SESSION, not IP; a high safety ceiling that clears normal
   *  conversational cadence (a turn every few seconds) so a live call is never throttled. */
  tavusCallback: { capacity: 60, refillPerSec: 2 },
  /** Recording blob/chunk uploads (already byte-capped; this caps request spam). */
  upload: { capacity: 60, refillPerSec: 2 },
  /** Per-utterance transcript posts (high-frequency during a live call). */
  utterance: { capacity: 90, refillPerSec: 4 },
  /** Client activity beacon (already batched). */
  beacon: { capacity: 30, refillPerSec: 1 },
  /** Login POST — throttles credential brute-force. */
  auth: { capacity: 10, refillPerSec: 0.2 },
} as const;

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 50_000; // backstop against unbounded growth from unique IP keys

/** Pure token-bucket check (no env gate). Exported for testing; routes use limited() below. */
export function rateLimit(key: string, cfg: LimitConfig, now: number): { ok: boolean; retryAfterSec: number } {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) evictIdle(now);
    b = { tokens: cfg.capacity, last: now };
    buckets.set(key, b);
  }
  const elapsedSec = Math.max(0, (now - b.last) / 1000);
  b.tokens = Math.min(cfg.capacity, b.tokens + elapsedSec * cfg.refillPerSec);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / cfg.refillPerSec)) };
}

/** Drop buckets idle > 10 min (they'd have refilled to full anyway → losing them is harmless). */
function evictIdle(now: number): void {
  const cutoff = now - 10 * 60_000;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}

/** Best-effort client IP. On Render (behind their edge) the real client is the leftmost
 *  x-forwarded-for entry; the app is never directly exposed, so it isn't spoofable here. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Route helper: enforce a limit and return a ready 429 Response if exceeded, else null (caller
 * proceeds). No-op unless NEXUSREP_RATELIMIT=1 (OPT-IN — off by default; see env.rateLimitEnabled for
 * why). Keyed by IP unless a keyOverride is given (e.g. the Tavus callback keys by session id — never
 * IP, which is shared across Tavus egress).
 */
export function limited(req: Request, name: keyof typeof LIMITS, keyOverride?: string): NextResponse | null {
  if (!env.rateLimitEnabled) return null;
  const key = `${name}:${keyOverride ?? clientIp(req)}`;
  const res = rateLimit(key, LIMITS[name], Date.now());
  if (res.ok) return null;
  return NextResponse.json(
    { error: "Too many requests — slow down.", retryAfterSec: res.retryAfterSec },
    { status: 429, headers: { "retry-after": String(res.retryAfterSec) } },
  );
}

/** Test-only: clear all buckets so cases don't bleed into each other. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
