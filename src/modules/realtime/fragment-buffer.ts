/**
 * Live ASR fragment/utterance buffering for the Tavus custom-LLM path. Tavus sometimes delivers a
 * turn in pieces — a trailing-comma stub ("What is the liberation,") then a tail shard ("BRUE?") — or
 * a recovered mis-hearing split across two calls. This stateful helper decides, per live session,
 * whether to BUFFER an incomplete fragment, MERGE a continuation, IGNORE a trailing shard, and
 * replay the recovered answer instead of logging a duplicate turn.
 *
 * Extracted verbatim from the /api/tavus/llm route so the realtime turn-shaping lives in the realtime
 * module (not an OpenAI-shim controller). SAFETY: an adverse-event report is never held behind
 * buffering just because Tavus left a trailing comma — a partial AE route beats silence
 * (isLikelyIncompleteFragment). The maps are process-global (one live-session map per instance),
 * exactly as before.
 */

import { wordCount } from "@lib/pacing";

export const FRAGMENT_WINDOW_MS = 2500;

type FragmentState = { text: string; at: number };
const pendingFragments = new Map<string, FragmentState>();
const recoveredFragmentUntil = new Map<string, number>();
const recoveredFragmentReplies = new Map<string, { reply: string; until: number }>();

export function isLikelyIncompleteFragment(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Safety reports must not be held behind fragment buffering just because
  // Tavus leaves a trailing comma. A partial AE route is better than silence.
  if (
    /\b(?:patient|hcp|doctor|he|she|they|i)\b[\s\S]{0,80}\b(?:had|has|developed|experienced|reported|while taking|after taking|on)\b[\s\S]{0,80}\b(?:bleeding|rash|swelling|reaction|hospitali[sz]ed|dizz(?:y|iness)|nausea|side effect|adverse)\b/i.test(t) ||
    /\b(?:bleeding|rash|swelling|reaction|hospitali[sz]ed|dizz(?:y|iness)|nausea)\b[\s\S]{0,80}\b(?:after|while taking|on|from|with)\b/i.test(t)
  ) return false;
  if (/\bliberation\b/i.test(t)) return false;
  if (/[,:;–-]\s*$/.test(t)) return true;
  return /^(?:what|how|tell|explain|can|could|does|is)\b/i.test(t) && wordCount(t) <= 3 && !/[?!.]\s*$/.test(t);
}

export function isLikelyFragmentContinuation(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (wordCount(t) <= 3) return true;
  return /^[a-z]/.test(t);
}

export function mergeOrBufferFragment(sessionKey: string, text: string, now = Date.now()):
  | { action: "buffer" }
  | { action: "process"; text: string; merged?: boolean } {
  const prev = pendingFragments.get(sessionKey);
  if (prev && now - prev.at <= FRAGMENT_WINDOW_MS && isLikelyFragmentContinuation(text)) {
    pendingFragments.delete(sessionKey);
    return { action: "process", text: `${prev.text.replace(/\s+$/, "")} ${text.trim()}`, merged: true };
  }
  if (prev) pendingFragments.delete(sessionKey);
  if (isLikelyIncompleteFragment(text)) {
    pendingFragments.set(sessionKey, { text, at: now });
    return { action: "buffer" };
  }
  return { action: "process", text };
}

export function shouldIgnoreTrailingRecoveredFragment(sessionKey: string, text: string, now = Date.now()): boolean {
  const until = recoveredFragmentUntil.get(sessionKey) ?? 0;
  if (now > until) {
    recoveredFragmentUntil.delete(sessionKey);
    return false;
  }
  const t = text.trim();
  return wordCount(t) <= 2 && /^[a-z]{2,8}\??$/i.test(t);
}

/** Open the window during which a tiny trailing shard is treated as a duplicate of a recovered turn. */
export function markRecoveredFragmentWindow(sessionKey: string, now = Date.now()): void {
  recoveredFragmentUntil.set(sessionKey, now + FRAGMENT_WINDOW_MS);
}

/** Cache the approved reply for a recovered fragment so a following shard can replay it (not re-log).
 *  TTL derives from the caller's composer timeout so it outlives an in-flight compose. */
export function rememberRecoveredFragmentReply(sessionKey: string, reply: string, composerTimeoutMs: number, now = Date.now()): void {
  if (!reply.trim()) return;
  recoveredFragmentReplies.set(sessionKey, { reply, until: now + Math.max(7000, composerTimeoutMs + FRAGMENT_WINDOW_MS) });
}

export function getRecoveredFragmentReply(sessionKey: string, now = Date.now()): string | null {
  const cached = recoveredFragmentReplies.get(sessionKey);
  if (!cached) return null;
  if (now > cached.until) {
    recoveredFragmentReplies.delete(sessionKey);
    return null;
  }
  return cached.reply;
}

export async function waitForRecoveredFragmentReply(sessionKey: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = getRecoveredFragmentReply(sessionKey);
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getRecoveredFragmentReply(sessionKey);
}
