/**
 * Ends a Tavus conversation by id — the preview calls this on close so the conversation
 * doesn't linger and consume one of the account's concurrent-conversation slots. Best-effort,
 * always returns JSON (never throws an HTML error the client can't parse).
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
