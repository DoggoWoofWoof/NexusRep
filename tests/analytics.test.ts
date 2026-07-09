import { describe, expect, it } from "vitest";
import { TargetingService, scoreOpportunity, whitespaceOf, MILVEXIAN_COHORT, type HCPFeatures } from "@modules/audience";
import { createContainer } from "@lib/container";
import { asId } from "@lib/ids";

const feature = (over: Partial<HCPFeatures>): HCPFeatures => ({
  id: asId<"hcp_id">("hcp_x"),
  name: "Dr. X",
  specialty: "General Physician",
  decile: 3,
  eligiblePatients: 2000,
  brandSharePct: 10,
  trendPct: 5,
  seesReps: true,
  repTouchesQtr: 1,
  ...over,
});

describe("TargetingService opportunity scoring", () => {
  it("scores from aggregate features deterministically", () => {
    // whitespace 0.94, density 0.8134, trend 0.9333 → 89.4
    const s = scoreOpportunity(feature({ brandSharePct: 6, eligiblePatients: 2847, trendPct: 18 }));
    expect(s).toBe(89.4);
  });

  it("higher whitespace (lower brand share) scores higher, all else equal", () => {
    const low = scoreOpportunity(feature({ brandSharePct: 5 }));
    const high = scoreOpportunity(feature({ brandSharePct: 40 }));
    expect(low).toBeGreaterThan(high);
  });

  it("derives whitespace segment from coverage features", () => {
    expect(whitespaceOf(feature({ seesReps: false }))).toBe("no_see");
    expect(whitespaceOf(feature({ seesReps: true, repTouchesQtr: 0 }))).toBe("no_rep");
    expect(whitespaceOf(feature({ seesReps: true, repTouchesQtr: 2 }))).toBe("under_covered");
  });

  it("ranks the cohort highest-first and counts high-opportunity HCPs", () => {
    const t = new TargetingService(MILVEXIAN_COHORT);
    const ranked = t.rank();
    expect(ranked[0]?.name).toBe("Dr. M. Okafor");
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    expect(t.highOpportunityCount(75)).toBe(4);
    expect(t.cohortSize()).toBe(8);
  });

  it("never emits patient-level phrasing (aggregate, no PHI)", () => {
    const t = new TargetingService(MILVEXIAN_COHORT);
    for (const h of t.rank()) {
      expect(h.eligiblePatientOpportunity.toLowerCase()).toContain("no phi");
    }
  });
});

describe("AnalyticsService aggregation (integration via container)", () => {
  it("derives metrics from the seeded Milvexian history — not hardcoded", async () => {
    // Demo history is opt-in now (off by default so real usage isn't polluted).
    const c = await createContainer({ seedHistory: true });
    const a = await c.analytics.all();

    // Engagement: 6 seeded sessions, all completed (duration > 0).
    const sessions = a.engagement.find((m) => m.key === "sessions");
    expect(sessions?.value).toBe("6");
    expect(a.engagement.find((m) => m.key === "completed")?.value).toBe("6");

    // Compliance: 1 AE capture (pharmacovigilance follow-up) in the seed.
    expect(a.compliance.find((m) => m.key === "ae")?.value).toBe("1");
    // MSL/medical routings: 2 msl + 1 medical_information = 3.
    expect(a.compliance.find((m) => m.key === "offlabel")?.value).toBe("3");

    // Targeting: pulls straight from the real scorer.
    expect(a.targeting.find((m) => m.key === "high_opp")?.value).toBe("4");
    expect(a.targeting.find((m) => m.key === "eligible")?.value).toBe("19,020");

    // Content gaps: the three public-info topics (mechanism/program/status) are all covered.
    expect(a.content.find((m) => m.key === "gaps")?.value).toBe("0");

    // Realtime: no live turns in a fresh container → honest em dash, not a fake number.
    expect(a.realtime_quality.find((m) => m.key === "latency_p50")?.value).toBe("—");
  });
});
