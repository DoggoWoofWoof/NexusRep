/**
 * Activity feed query for the Admin → Activity dashboard. Thin controller: parses filters and returns
 * the (newest-first) matching events + a global summary (totals, per-category / per-user counts, the
 * latest seq the client polls with). Reads the process-global cross-user log — this is the
 * platform-admin observability surface, never reachable from the doctor view.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { queryActivity } from "@modules/activity";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const u = new URL(req.url).searchParams;
  const num = (k: string): number | undefined => {
    const v = u.get(k);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const { events, summary } = queryActivity({
    user: u.get("user") || undefined,
    category: u.get("category") || undefined,
    surface: u.get("surface") || undefined,
    severity: u.get("severity") || undefined,
    sessionId: u.get("sessionId") || undefined,
    q: u.get("q") || undefined,
    sinceSeq: num("sinceSeq"),
    limit: num("limit"),
  });
  return NextResponse.json({ events, summary });
}
