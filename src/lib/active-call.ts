/**
 * Tracks each live video call's NexusRep session + the user whose container owns it. The realtime
 * vendor's servers call our compliance endpoint (/api/tavus/llm) WITHOUT the browser's auth cookie,
 * so that endpoint can't resolve the signed-in user on its own — and the call's session lives in that
 * user's per-user container. Recording it here lets the callback reload the SAME container + session,
 * so every turn threads one session (ISI once, disclosure once, slides continue).
 *
 * Keyed BY OWNER (not a single slot) so two accounts can run video at once without the second call
 * superseding the first and steering its turns into the wrong container — the cross-user leak. The
 * cookie-less callback resolves the owner from its per-user LLM URL (/api/tavus/llm/o/<owner>) and
 * looks up THAT owner's active call here.
 */

export interface ActiveCall {
  sessionId: string;
  /** Container owner (signed-in user), or null for the shared/default container (auth off, or a
   *  public doctor link with no cookie). The vendor callback resolves the SAME one from its URL. */
  userId: string | null;
}

/** The owner-key for the shared/default container (auth off, or a public doctor link with no cookie).
 *  Exported so every producer/consumer of the per-owner keying uses the SAME sentinel — a drift would
 *  route a cookie-less Tavus turn to the wrong container. */
export const DEFAULT_OWNER_KEY = "__default__";

const keyOf = (userId: string | null | undefined): string => userId ?? DEFAULT_OWNER_KEY;
const activeCalls = new Map<string, ActiveCall>();

export function setActiveCall(call: ActiveCall): void {
  // Overwrites only THIS owner's entry — a different owner's concurrent call is a different key, so
  // it can't supersede this one (that superseding was the cross-user data leak).
  activeCalls.set(keyOf(call.userId), call);
}

export function getActiveCall(userId: string | null = null): ActiveCall | null {
  return activeCalls.get(keyOf(userId)) ?? null;
}
