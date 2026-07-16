/**
 * Marks a server-returned Tavus rep utterance as not actually spoken.
 *
 * The custom-LLM endpoint must log generated answers before returning them to Tavus, but a doctor
 * can barge in before Tavus starts audio. In that case the session's spoken transcript should not
 * claim the avatar said the cancelled answer. Audit still keeps the generated/gated output.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; text?: unknown };
  const sessionId = typeof body.sessionId === "string" ? asId<"session_id">(body.sessionId) : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!sessionId || !text) {
    return NextResponse.json({ error: "sessionId and text are required" }, { status: 400 });
  }

  const c = await getContainer();
  const result = await c.sessions.removeRecentTurn(sessionId, { speaker: "rep", text });
  if (!result.session) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  if (result.removed) {
    await c.audit.record(sessionId, "response_validation", { action: "rep_output_interrupted_before_audio" });
  }
  return NextResponse.json({ ok: true, removed: result.removed });
}
