/**
 * Removes STRAY preview sessions — a brand-user preview (opened /hcp to try the rep) that produced
 * no recording and no real Q&A, just the greeting. Called when a preview ends, and safe to call
 * anytime to sweep old clutter.
 *
 * Safety (per the "don't hijack sessions in use" rule): it NEVER deletes a session with a recording,
 * with real questions, the currently-active/live call, or one still recent (may be open in another
 * tab). Only ENDED, empty previews go — see SessionService.pruneStrayPreviews.
 */

import { NextResponse } from "next/server";
import { getContainer, currentUserId } from "@lib/container";
import { getActiveCall } from "@lib/active-call";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { endedSessionId?: unknown };
  const endedSessionId = typeof body.endedSessionId === "string" ? body.endedSessionId : undefined;
  const c = await getContainer();
  // Never prune THIS owner's live call (their active call is keyed by their own id). Only the caller's
  // container is swept (getContainer → their namespace), so this can't touch another account's data.
  const active = getActiveCall(await currentUserId());
  const removed = await c.sessions.pruneStrayPreviews({ activeSessionId: active?.sessionId, endedSessionId });
  return NextResponse.json({ ok: true, removed: removed.length });
}
