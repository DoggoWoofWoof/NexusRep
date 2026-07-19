/**
 * Vendor usage & cost feed for the Admin dashboard. Thin controller: reads the process-global usage
 * ledger (Claude/OpenAI tokens, TTS characters, Tavus video seconds) and returns a cost rollup.
 * Admins only — this is platform-cost observability, never reachable from the doctor view.
 *
 * GET /api/usage            → overall summary + per-session totals + recent events
 * GET /api/usage?sessionId= → one conversation's detailed breakdown (events + rollup)
 */

import { NextResponse } from "next/server";
import { requireAdminUser } from "@lib/require-auth";
import { getUsageLedger } from "@modules/usage";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const _auth = await requireAdminUser(); // platform-cost observability → admins only
  if (!_auth.ok) return _auth.res;

  const ledger = getUsageLedger();
  const sessionId = new URL(req.url).searchParams.get("sessionId") || undefined;

  if (sessionId) {
    return NextResponse.json({
      sessionId,
      summary: ledger.sessionSummary(sessionId),
      events: ledger.forSession(sessionId),
    });
  }

  return NextResponse.json({
    summary: ledger.summary(),
    perSession: ledger.perSession(),
    recent: ledger.recent(200),
  });
}
