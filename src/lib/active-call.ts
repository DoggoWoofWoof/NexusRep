/**
 * Tracks the most-recently-started live video call: its NexusRep session id AND the user whose
 * container owns that session. The realtime vendor's servers call our compliance endpoint
 * (/api/tavus/llm) WITHOUT the browser's auth cookie, so that endpoint can't resolve the
 * signed-in user on its own — and the call's session lives in that user's per-user container.
 * Recording BOTH here lets the vendor callback load the SAME container and the SAME session, so
 * every turn threads one session (ISI once, disclosure once, slides continue). Without the userId,
 * the callback fell back to the default container, never found the session, and started a FRESH
 * session per turn — which re-delivered the ISI on every reply.
 *
 * Vendor-neutral: any provider's callback reads the same slot. Scope: one active call at a time
 * (the demo). A multi-tenant deployment would key this off the vendor conversation id via a
 * per-conversation callback URL instead of a single global.
 */

export interface ActiveCall {
  sessionId: string;
  /** Container owner (signed-in user), or null for the shared/default container (auth off, or a
   *  public doctor link with no cookie). The vendor callback must resolve the SAME one. */
  userId: string | null;
}

let activeCall: ActiveCall | null = null;

export function setActiveCall(call: ActiveCall): void {
  if (activeCall && activeCall.sessionId !== call.sessionId) {
    // Known single-slot limitation: a second concurrent call supersedes the first — its replies
    // would then log to the NEW session. Loudly visible on purpose (one video call per process).
    console.warn(`[realtime] active call superseded: ${activeCall.sessionId} → ${call.sessionId} (one concurrent video call per process)`);
  }
  activeCall = call;
}

export function getActiveCall(): ActiveCall | null {
  return activeCall;
}
