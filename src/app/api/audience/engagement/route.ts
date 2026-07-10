/**
 * Thin controller — real engagement summary for one cohort doctor (the Audience
 * drawer's "Engagement so far"). Aggregated from our own session/follow-up logs
 * by AnalyticsService; HCP-level only, never patient-level.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const hcp = new URL(req.url).searchParams.get("hcp") ?? "";
  if (!hcp.trim()) return NextResponse.json({ error: "hcp is required" }, { status: 400 });
  const c = await getContainer();
  return NextResponse.json(await c.analytics.engagementForHcp(hcp));
}
