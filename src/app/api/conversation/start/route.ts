/**
 * Thin controller — opens a new preview session and returns its id. The client
 * passes this id on subsequent /api/conversation/turn calls so each preview is a
 * distinct, reviewable session (brief §10). No business logic here.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";

export async function POST(): Promise<NextResponse> {
  const c = await getContainer();
  const session = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
  return NextResponse.json({ sessionId: session.id, startedAt: session.startedAt });
}
