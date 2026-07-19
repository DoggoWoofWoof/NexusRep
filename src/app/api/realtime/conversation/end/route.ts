/**
 * Ends a live video conversation by id — the client calls this on close so the conversation doesn't
 * linger and consume one of the vendor account's concurrent-session slots. Vendor-neutral (whatever
 * getRealtimeProvider() resolves). Best-effort, always returns JSON.
 *
 * It also records WHY the call ended: a DELIBERATE "End" click (reason "ended_by_doctor") is stamped
 * on the session + surfaced in the admin Activity feed, so an operator can tell it apart from a
 * timeout/disconnect (which only Tavus's shutdown webhook reports). The unmount/tab-close backstop
 * ("cleanup") is intentionally NOT recorded here — Tavus's shutdown reason is more accurate for those.
 */

import { NextResponse } from "next/server";
import { getRealtimeProvider } from "@modules/vendors";
import { currentUserId, getContainerForUser } from "@lib/container";
import { logServerActivity } from "@lib/activity-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { conversationId?: unknown; reason?: unknown };
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    if (!conversationId) return NextResponse.json({ ended: false });
    // Default to the deliberate-End meaning; the client sends "cleanup" for the silent unmount backstop.
    const deliberate = body.reason !== "cleanup";

    await getRealtimeProvider().endConversation(conversationId).catch(() => {});

    if (deliberate) {
      const owner = await currentUserId();
      const c = await getContainerForUser(owner);
      const session = await c.sessions.getByVendorConversation(conversationId);
      if (session) await c.sessions.setEndReason(conversationId, "ended_by_doctor"); // first wins over a later timeout
      void logServerActivity({
        user: owner ?? "doctor",
        category: "video",
        action: "Doctor ended the video call (pressed End)",
        target: conversationId,
        sessionId: session?.id ? String(session.id) : undefined,
        severity: "notice",
        metadata: { conversationId, reason: "ended_by_doctor" },
      });
    }
    return NextResponse.json({ ended: true });
  } catch {
    return NextResponse.json({ ended: false });
  }
}
