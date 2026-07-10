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
  // A degraded source (boot-time fallback to the modeled cohort) retries here, throttled —
  // the live claims cohort comes back without a restart, and the UI banners on `degraded`.
  if (c.audienceRuntime.degraded) await c.audienceRuntime.refresh().catch(() => false);
  const t = c.targeting;
  const seg = t.segmentCounts();
  return NextResponse.json({
    source: c.audienceRuntime.source,
    degraded: c.audienceRuntime.degraded,
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
