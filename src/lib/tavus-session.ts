/**
 * Tracks the most-recently-started Tavus call session. Tavus's servers call our custom-LLM
 * endpoint (/api/tavus/llm) WITHOUT our session id, so this lets that endpoint log the
 * authoritative transcript — HCP + rep turns, each with the detail-aid slide the rep showed —
 * to the correct session (and fixes audit landing on the shared demo session).
 *
 * Scope: one active call at a time (the demo). A multi-tenant deployment would instead key the
 * session off the Tavus conversation id, passed through the persona's per-conversation LLM URL.
 */

let activeTavusSessionId: string | null = null;

export function setActiveTavusSession(id: string): void {
  if (activeTavusSessionId && activeTavusSessionId !== id) {
    // Known single-slot limitation: a second concurrent call supersedes the first —
    // its subsequent replies would log to the NEW session. Loudly visible on purpose.
    console.warn(`[tavus] active call superseded: ${activeTavusSessionId} → ${id} (one concurrent Tavus call per process)`);
  }
  activeTavusSessionId = id;
}

export function getActiveTavusSession(): string | null {
  return activeTavusSessionId;
}
