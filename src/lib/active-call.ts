/**
 * Tracks the most-recently-started live video call session. The realtime vendor's servers
 * call our compliance endpoint WITHOUT our session id, so this lets that endpoint log the
 * authoritative transcript — HCP + rep turns, each with the detail-aid slide the rep showed —
 * to the correct session (and fixes audit landing on the shared demo session).
 *
 * Vendor-neutral: any realtime provider's callback route reads the same slot. Scope: one
 * active call at a time (the demo). A multi-tenant deployment would instead key the session
 * off the vendor conversation id, passed through a per-conversation callback URL.
 */

let activeCallSessionId: string | null = null;

export function setActiveCallSession(id: string): void {
  if (activeCallSessionId && activeCallSessionId !== id) {
    // Known single-slot limitation: a second concurrent call supersedes the first —
    // its subsequent replies would log to the NEW session. Loudly visible on purpose.
    console.warn(`[realtime] active call superseded: ${activeCallSessionId} → ${id} (one concurrent video call per process)`);
  }
  activeCallSessionId = id;
}

export function getActiveCallSession(): string | null {
  return activeCallSessionId;
}
