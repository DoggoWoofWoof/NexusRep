/**
 * Thin controller — live targeting cohort, ranked by the real opportunity
 * scorer, plus summary metrics and the cohort source (DocNexus vs modeled).
 * No business logic here; TargetingService does the scoring.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  const t = c.targeting;
  const seg = t.segmentCounts();
  return NextResponse.json({
    source: c.demo.audienceSource,
    summary: {
      highOpportunity: t.highOpportunityCount(75),
      averageScore: t.averageScore(),
      eligiblePatients: t.totalEligiblePatients(),
      cohortSize: t.cohortSize(),
      segments: seg,
    },
    rows: t.rank(),
  });
}
