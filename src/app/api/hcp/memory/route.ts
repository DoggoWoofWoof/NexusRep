/**
 * Per-HCP cross-session memory for the brand console (HCP drawer / audience view). Returns the rolling,
 * non-PII recap we keep on OUR side for one HCP — prior-session topics, counts, and whether a human or an
 * adverse event was ever raised. Brand-gated (never doctor-facing). Thin controller over HcpMemoryService.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";
import { asId, type HcpId } from "@lib/ids";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const hcpId = new URL(req.url).searchParams.get("hcpId") || "";
  if (!hcpId) return NextResponse.json({ error: "hcpId is required" }, { status: 400 });
  const c = await getContainer();
  const mem = await c.hcpMemory.get(asId<"hcp_id">(hcpId) as HcpId);
  return NextResponse.json({
    memory: mem
      ? {
          hcpId: String(mem.hcpId),
          sessionCount: mem.sessionIds.length,
          lastSessionAt: mem.lastSessionAt,
          topics: mem.topics,
          intents: mem.intents,
          routes: mem.routes,
          everRequestedHuman: mem.everRequestedHuman,
          everReportedAe: mem.everReportedAe,
          recap: mem.recap,
          updatedAt: mem.updatedAt,
        }
      : null,
  });
}
