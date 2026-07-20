/**
 * Thin controller — the full compliance evidence for one session: its turns and
 * the append-only audit trail (classification → routing → gate decision →
 * output → follow-up). Live sessions carry the real turn-level record; seeded
 * demo history has header-level status only (no per-turn transcript).
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";
import { deriveSessionDurationSeconds } from "@modules/sessions";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const { id } = await ctx.params;
  const sessionId = asId<"session_id">(id);
  const c = await getContainer();
  const session = await c.sessions.get(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session" }, { status: 404 });

  const audit = await c.audit.forSession(sessionId);
  // The replay's slide is driven by the detail-aid the rep actually showed — stored on
  // the turn. For turns recorded before that field existed, resolve it from the turn's
  // approved-answer id (its canonical slide), so old recordings still play the right slide.
  const turns = await Promise.all(
    session.turns.map(async (t) => {
      let detailAidSlideId = t.detailAidSlideId ?? null;
      if (!detailAidSlideId && t.speaker === "rep" && t.sourceIds[0]) {
        const answer = await c.content.getAnswer(asId(t.sourceIds[0]));
        detailAidSlideId = answer?.detailAidSlideId ?? null;
      }
      return { speaker: t.speaker, text: t.text, sourceIds: t.sourceIds, detailAidSlideId, at: t.at ?? null };
    }),
  );
  return NextResponse.json({
    session: {
      id: session.id,
      // A brand-user preview (opened /hcp to try the rep) is never a real doctor — show "Preview".
      // Otherwise live cohort first (canonical ids from the claims source), demo-seed names as fallback.
      hcp: session.preview ? "Preview (you)" : c.targeting.get(String(session.hcpId))?.name ?? hcpNameOf(session.hcpId),
      startedAt: session.startedAt,
      durationSeconds: deriveSessionDurationSeconds(session),
      questionCount: session.questionCount,
      complianceStatus: session.complianceStatus,
      recordingUrl: session.recordingUrl ?? null,
      recordingDurationMs: session.recordingDurationMs ?? null,
      timelineSource: session.timelineSource ?? null,
      endReason: session.endReason ?? null,
      // Live-monitoring / takeover state: a session is "live" while it has no end reason and no recording
      // yet; takenOverBy names the human rep currently handling it (null = the AI is answering).
      live: !session.endReason && !session.recordingUrl,
      takenOverBy: session.takenOverBy ?? null,
    },
    turns,
    audit: audit.map((a) => ({ seq: a.seq, type: a.type, payload: a.payload })),
    hasTurnDetail: session.turns.length > 0,
  });
}
