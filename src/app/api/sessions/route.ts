/**
 * Thin controller — live session list for the Sessions review surface, shaped
 * for display (HCP name, duration, compliance status, follow-up). Derived from
 * the SessionService + FollowUpService; no business logic here.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";
import type { SessionComplianceStatus } from "@modules/sessions";
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

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  const [sessions, followups] = await Promise.all([c.sessions.list(), c.followups.list()]);
  const rows = sessions.filter((s) => Boolean(s.recordingUrl)).map((s) => {
    const sessionFollowups = followups.filter((f) => f.sourceSessionId === s.id);
    const fu = sessionFollowups[0];
    return {
      id: s.id,
      hcp: hcpNameOf(s.hcpId),
      date: s.startedAt.replace("T", " ").slice(0, 16),
      duration: mmss(s.durationSeconds),
      questions: s.questionCount,
      comp: COMP[s.complianceStatus].label,
      compTone: COMP[s.complianceStatus].tone,
      hasRecording: true,
      followup: sessionFollowups.length > 1 ? `${sessionFollowups.length} follow-ups` : fu ? FOLLOWUP_LABEL[fu.type] : "—",
    };
  });
  return NextResponse.json({ rows });
}
