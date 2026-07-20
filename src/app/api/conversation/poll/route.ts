/**
 * PUBLIC poll for the DOCTOR side during a human takeover. When the AI hands a turn to a human (the turn
 * route returned held:true), the doctor's page polls here for the human rep's reply. Keyed by the session
 * id the doctor already holds; returns only the latest rep reply text + the running rep-turn count, so the
 * client can tell when a NEW reply has landed. No auth (the doctor is unauthenticated), rate-limited.
 */

import { NextResponse } from "next/server";
import { limited } from "@lib/rate-limit";
import { getContainer } from "@lib/container";
import { asId, type SessionId } from "@lib/ids";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const limit = limited(req, "beacon");
  if (limit) return limit;
  const u = new URL(req.url).searchParams;
  const sessionIdRaw = u.get("sessionId") || "";
  const repSeen = Math.max(0, Math.trunc(Number(u.get("repSeen")) || 0));
  if (!sessionIdRaw) return NextResponse.json({ newReply: null, repCount: 0, takenOver: false });

  const c = await getContainer();
  const session = await c.sessions.get(asId<"session_id">(sessionIdRaw) as SessionId);
  if (!session) return NextResponse.json({ newReply: null, repCount: 0, takenOver: false });

  const repTurns = session.turns.filter((t) => t.speaker === "rep");
  const newReply = repTurns.length > repSeen ? repTurns[repTurns.length - 1]?.text ?? null : null;
  return NextResponse.json({ newReply, repCount: repTurns.length, takenOver: Boolean(session.takenOverBy) });
}
