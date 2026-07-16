/**
 * Records one spoken/typed utterance into a session's transcript. The live video
 * client (VideoAgentStage) posts every finalized utterance here — both the doctor's
 * transcribed speech and the rep's spoken reply (greeting included) — so the
 * session transcript is the faithful, both-sided record of the actual call,
 * time-ordered and reviewable alongside the recording (YouTube-style).
 *
 * This is a fallback transcript path for local video calls where Tavus cannot
 * reach our custom-LLM endpoint. In normal Tavus calls, the compliance endpoint logs via
 * ConversationService.turn(), including approved source IDs and slide IDs, so
 * this endpoint stays quiet and nothing is double-counted.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; speaker?: unknown; text?: unknown; at?: unknown };
  const speaker = body.speaker === "rep" ? "rep" : body.speaker === "hcp" ? "hcp" : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const at = typeof body.at === "string" && Number.isFinite(Date.parse(body.at)) ? body.at : undefined;
  const sessionId = typeof body.sessionId === "string" ? asId<"session_id">(body.sessionId) : null;
  if (!sessionId || !speaker || !text) {
    return NextResponse.json({ error: "sessionId, speaker (hcp|rep), and text are required" }, { status: 400 });
  }

  const c = await getContainer();
  const session = await c.sessions.get(sessionId);
  if (!session) return NextResponse.json({ error: "unknown session" }, { status: 404 });

  // Idempotency: skip an exact repeat by the same speaker within the RECENT window — Tavus
  // can re-emit an utterance even after an interleaved turn (a last-turn-only check missed
  // that), and we never want a doubled transcript line.
  const recent = session.turns.slice(-6);
  if (recent.some((t) => t.speaker === speaker && t.text.trim() === text)) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  await c.sessions.appendTurn(sessionId, { speaker, text, ...(at ? { at } : {}) });
  return NextResponse.json({ ok: true });
}
