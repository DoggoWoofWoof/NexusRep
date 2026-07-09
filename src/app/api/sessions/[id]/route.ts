/**
 * Thin controller — the full compliance evidence for one session: its turns and
 * the append-only audit trail (classification → routing → gate decision →
 * output → follow-up). Live sessions carry the real turn-level record; seeded
 * demo history has header-level status only (no per-turn transcript).
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";
import { deriveSessionDurationSeconds } from "@modules/sessions";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
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
      hcp: hcpNameOf(session.hcpId),
      startedAt: session.startedAt,
      durationSeconds: deriveSessionDurationSeconds(session),
      questionCount: session.questionCount,
      complianceStatus: session.complianceStatus,
      recordingUrl: session.recordingUrl ?? null,
    },
    turns,
    audit: audit.map((a) => ({ seq: a.seq, type: a.type, payload: a.payload })),
    hasTurnDetail: session.turns.length > 0,
  });
}
