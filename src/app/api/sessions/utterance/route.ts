/**
 * Records one spoken/typed utterance into a session's transcript. The live video
 * client (TavusStage) posts every finalized utterance here — both the doctor's
 * transcribed speech and the rep's spoken reply (greeting included) — so the
 * session transcript is the faithful, both-sided record of the actual call,
 * time-ordered and reviewable alongside the recording (YouTube-style).
 *
 * This is the transcript source of truth for Tavus calls; the custom-LLM endpoint
 * only runs the compliance gate and returns text (it does not log), so nothing is
 * double-counted.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; speaker?: unknown; text?: unknown };
  const speaker = body.speaker === "rep" ? "rep" : body.speaker === "hcp" ? "hcp" : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? asId<"session_id">(body.sessionId) : null;
  if (!sessionId || !speaker || !text) {
    return NextResponse.json({ error: "sessionId, speaker (hcp|rep), and text are required" }, { status: 400 });
  }

  const c = await getContainer();
  const session = await c.sessions.get(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session" }, { status: 404 });

  // Idempotency: skip an exact repeat of the last turn by the same speaker — Tavus
  // can re-emit an utterance, and we never want a doubled transcript line.
  const last = session.turns[session.turns.length - 1];
  if (last && last.speaker === speaker && last.text.trim() === text) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  await c.sessions.appendTurn(sessionId, { speaker, text });
  return NextResponse.json({ ok: true });
}
