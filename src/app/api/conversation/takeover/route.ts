/**
 * Human-in-the-loop takeover controls for the brand rep. A signed-in rep can TAKE a live conversation,
 * REPLY into it directly (trusted — the human's message is delivered as-is, NOT AI-gated, but fully
 * logged), and HAND it BACK to the AI. All three are recorded to the audit trail (in ConversationService)
 * AND the cross-user activity feed here, so "keep the human trusted but log everything" holds. Thin
 * controller over ConversationService.takeOver / humanReply / handBack.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";
import { logServerActivity } from "@lib/activity-log";
import { asId, type SessionId } from "@lib/ids";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const by = _auth.user || "rep";

  const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; action?: unknown; text?: unknown };
  const sessionIdRaw = typeof body.sessionId === "string" ? body.sessionId : "";
  const action = body.action;
  if (!sessionIdRaw || (action !== "take" && action !== "reply" && action !== "hand_back")) {
    return NextResponse.json({ error: "sessionId and action (take | reply | hand_back) are required" }, { status: 400 });
  }
  const sessionId = asId<"session_id">(sessionIdRaw) as SessionId;
  const c = await getContainer();

  let session;
  if (action === "take") {
    session = await c.conversation.takeOver(sessionId, by);
    void logServerActivity({ user: by, category: "session", action: "Took over conversation", target: sessionIdRaw, sessionId: sessionIdRaw, severity: "notice" });
  } else if (action === "hand_back") {
    session = await c.conversation.handBack(sessionId);
    void logServerActivity({ user: by, category: "session", action: "Handed conversation back to AI", target: sessionIdRaw, sessionId: sessionIdRaw });
  } else {
    const text = (typeof body.text === "string" ? body.text : "").trim().slice(0, 2000);
    if (!text) return NextResponse.json({ error: "text is required for a reply" }, { status: 400 });
    session = await c.conversation.humanReply(sessionId, { text, by });
    // Full transcript of the human message is logged (trusted, not gated) — the audit + this activity line.
    void logServerActivity({ user: by, category: "session", action: "Human rep replied (live)", target: sessionIdRaw, sessionId: sessionIdRaw, metadata: { text } });
  }
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    takenOverBy: session.takenOverBy ?? null,
    turns: session.turns.map((t) => ({ speaker: t.speaker, text: t.text, human: t.human ?? false, at: t.at ?? null })),
  });
}
