type LiveTurnHandle = {
  token: number;
  sessionId: string;
  text: string;
  norm: string;
  startedAt: number;
};

type RecentTurn = {
  text: string;
  norm: string;
  completedAt: number;
};

type GuardState = {
  active: LiveTurnHandle[];
  recent: RecentTurn[];
  seq: number;
};

export type LiveTurnGuardDecision =
  | { action: "accept"; handle: LiveTurnHandle }
  | { action: "drop"; reason: "duplicate_in_flight" | "duplicate_recent" };

const ACTIVE_DUPLICATE_WINDOW_MS = 20_000;
const RECENT_DUPLICATE_WINDOW_MS = 6_000;
const states = new Map<string, GuardState>();

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "about", "can", "could", "do", "does", "for", "how", "i", "is",
  "it", "me", "of", "on", "or", "please", "should", "tell", "the", "to", "what", "would", "you",
]);

export function normalizeLiveTurnText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(norm: string): string[] {
  return norm.split(" ").filter(Boolean);
}

function contentTokens(norm: string): string[] {
  return tokens(norm).filter((word) => !STOP_WORDS.has(word));
}

function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const bset = new Set(b);
  return a.filter((word) => bset.has(word)).length / Math.max(a.length, b.length);
}

export function isSameLiveTurnText(a: string, b: string): boolean {
  const an = normalizeLiveTurnText(a);
  const bn = normalizeLiveTurnText(b);
  if (!an || !bn) return false;
  if (an === bn) return true;

  const aw = tokens(an);
  const bw = tokens(bn);
  const shorter = aw.length <= bw.length ? aw : bw;
  const longer = aw.length <= bw.length ? bw : aw;
  const isPrefix = shorter.every((word, index) => longer[index] === word);
  if (isPrefix && shorter.length >= 3 && shorter.length / longer.length >= 0.72) return true;

  const ac = contentTokens(an);
  const bc = contentTokens(bn);
  if (Math.max(ac.length, bc.length) < 2) return false;
  return overlapScore(ac, bc) >= 0.9;
}

function stateFor(sessionId: string): GuardState {
  const existing = states.get(sessionId);
  if (existing) return existing;
  const fresh = { active: [], recent: [], seq: 0 };
  states.set(sessionId, fresh);
  return fresh;
}

function prune(state: GuardState, now: number): void {
  state.recent = state.recent.filter((turn) => now - turn.completedAt <= RECENT_DUPLICATE_WINDOW_MS);
  state.active = state.active.filter((turn) => now - turn.startedAt <= ACTIVE_DUPLICATE_WINDOW_MS);
}

export function beginLiveTurn(sessionId: string, text: string, now = Date.now()): LiveTurnGuardDecision {
  const norm = normalizeLiveTurnText(text);
  const state = stateFor(sessionId);
  prune(state, now);

  if (state.active.some((turn) => isSameLiveTurnText(turn.norm, norm))) {
    return { action: "drop", reason: "duplicate_in_flight" };
  }
  if (state.recent.some((turn) => isSameLiveTurnText(turn.norm, norm))) {
    return { action: "drop", reason: "duplicate_recent" };
  }

  const handle = { token: ++state.seq, sessionId, text, norm, startedAt: now };
  state.active.push(handle);
  return { action: "accept", handle };
}

export function finishLiveTurn(handle: LiveTurnHandle, now = Date.now()): { status: "current" | "superseded" } {
  const state = states.get(handle.sessionId);
  if (!state) return { status: "superseded" };
  const index = state.active.findIndex((turn) => turn.token === handle.token);
  const current = index >= 0;
  if (current) state.active.splice(index, 1);
  prune(state, now);
  if (current) state.recent.unshift({ text: handle.text, norm: handle.norm, completedAt: now });
  return { status: current ? "current" : "superseded" };
}

export function failLiveTurn(handle: LiveTurnHandle): void {
  const state = states.get(handle.sessionId);
  if (!state) return;
  state.active = state.active.filter((turn) => turn.token !== handle.token);
}

export function __resetLiveTurnGuardForTests(): void {
  states.clear();
}
