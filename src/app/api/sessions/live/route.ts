/**
 * Live-monitoring feed for the brand rep. Returns IN-PROGRESS conversations (no end reason, not yet
 * finalized to a recording, with real turns, started recently) and flags the ones where the AI rep
 * requested a HUMAN — so the console can alert the rep to come take over. Poll it every few seconds:
 * the transcript itself is captured turn-by-turn via /api/sessions/utterance, so this stays a turn or
 * two behind real time. Thin controller — derives from SessionService + FollowUpService, no logic.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";

export const dynamic = "force-dynamic";

const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // a session older than this with no end reason is stale, not live

export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const c = await getContainer();
  const [sessions, followups] = await Promise.all([c.sessions.list(), c.followups.list()]);

  // A human was requested for these sessions (the human_handoff route enqueues a human_rep follow-up).
  const humanRequested = new Set(followups.filter((f) => f.type === "human_rep").map((f) => String(f.sourceSessionId)));
  const now = Date.now();

  const live = sessions
    .filter((s) => !s.endReason && !s.recordingUrl && s.turns.length > 0 && now - Date.parse(s.startedAt) < LIVE_WINDOW_MS)
    .map((s) => {
      const last = s.turns[s.turns.length - 1];
      return {
        id: String(s.id),
        hcp: s.preview ? "Preview (you)" : c.targeting.get(String(s.hcpId))?.name ?? hcpNameOf(s.hcpId),
        complianceStatus: s.complianceStatus,
        turns: s.turns.length,
        lastSpeaker: last?.speaker ?? null,
        lastText: last?.text?.slice(0, 160) ?? "",
        startedAt: s.startedAt,
        needsHuman: humanRequested.has(String(s.id)),
      };
    })
    // Needs-a-human first, then most recently started.
    .sort((a, b) => Number(b.needsHuman) - Number(a.needsHuman) || Date.parse(b.startedAt) - Date.parse(a.startedAt));

  return NextResponse.json({ live, needsHumanCount: live.filter((s) => s.needsHuman).length });
}
