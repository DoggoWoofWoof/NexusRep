/**
 * Thin controller — live session list for the Sessions review surface, shaped
 * for display (HCP name, duration, compliance status, follow-up). Derived from
 * the SessionService + FollowUpService; no business logic here.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";
import { mmss } from "@lib/format";
import { deriveSessionDurationSeconds, type SessionComplianceStatus } from "@modules/sessions";
import type { FollowUpType } from "@modules/followups";

export const dynamic = "force-dynamic";

const COMP: Record<SessionComplianceStatus, { label: string; tone: string }> = {
  approved: { label: "Approved", tone: "green" },
  needs_review: { label: "Needs review", tone: "yellow" },
  ae_routed: { label: "AE routed", tone: "pink" },
  blocked_escalated: { label: "Blocked + escalated", tone: "red" },
};

const FOLLOWUP_LABEL: Record<FollowUpType, string> = {
  msl: "MSL follow-up",
  medical_information: "Medical info",
  pharmacovigilance: "PV routing",
  human_rep: "Rep follow-up",
};


export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const c = await getContainer();
  const [sessions, followups] = await Promise.all([c.sessions.list(), c.followups.list()]);
  // A session is reviewable when it has real turns OR a recording — same rule as the
  // detail view. (Filtering to recordings only made text/voice sessions invisible,
  // breaking the "improve from sessions" loop for non-video conversations.)
  const rows = sessions.filter((s) => s.turns.length > 0 || Boolean(s.recordingUrl)).map((s) => {
    const sessionFollowups = followups.filter((f) => f.sourceSessionId === s.id);
    const fu = sessionFollowups[0];
    return {
      id: s.id,
      // A brand-user preview (opened /hcp to try the rep) is never a real doctor — show "Preview".
      hcp: s.preview ? "Preview (you)" : c.targeting.get(String(s.hcpId))?.name ?? hcpNameOf(s.hcpId),
      date: s.startedAt.replace("T", " ").slice(0, 16),
      duration: mmss(deriveSessionDurationSeconds(s)),
      questions: s.questionCount,
      comp: COMP[s.complianceStatus].label,
      compTone: COMP[s.complianceStatus].tone,
      hasRecording: Boolean(s.recordingUrl),
      followup: sessionFollowups.length > 1 ? `${sessionFollowups.length} follow-ups` : fu ? FOLLOWUP_LABEL[fu.type] : "—",
    };
  });
  return NextResponse.json({ rows });
}
