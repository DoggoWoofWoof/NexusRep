/**
 * Ends a live video conversation by id — the client calls this on close so the conversation
 * doesn't linger and consume one of the vendor account's concurrent-session slots. Vendor-
 * neutral (whatever getRealtimeProvider() resolves). Best-effort, always returns JSON.
 */

import { NextResponse } from "next/server";
import { getRealtimeProvider } from "@modules/vendors";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { conversationId?: unknown };
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    if (conversationId) await getRealtimeProvider().endConversation(conversationId);
    return NextResponse.json({ ended: Boolean(conversationId) });
  } catch {
    return NextResponse.json({ ended: false });
  }
}
