/**
 * Thin controller — finalizes a preview session's duration so it appears
 * complete in the Sessions review surface. No business logic here.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; durationSeconds?: unknown };
  const sessionId = typeof body.sessionId === "string" ? asId<"session_id">(body.sessionId) : undefined;
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  const c = await getContainer();
  const durationSeconds = typeof body.durationSeconds === "number" ? body.durationSeconds : undefined;
  const session = await c.conversation.end(sessionId, { durationSeconds, endedAt: new Date().toISOString() });
  if (!session) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  return NextResponse.json({
    sessionId: session.id,
    durationSeconds: session.durationSeconds,
    questionCount: session.questionCount,
    complianceStatus: session.complianceStatus,
  });
}
