/**
 * Audience scoring improvements: cohort-aware weight renormalization (uniform
 * pre-launch signals can't rank anyone), honest per-component breakdown, and the
 * prefix-tolerant cohort lookup that fixes stripped-id session attribution.
 */
import { describe, expect, it } from "vitest";
import { TargetingService, effectiveWeights, scoreHcp, type HCPFeatures } from "../src/modules/audience";
import { asId } from "../src/lib/ids";

const hcp = (id: string, over: Partial<HCPFeatures> = {}): HCPFeatures => ({
  id: asId<"hcp_id">(id),
  name: `Dr. ${id}`,
  specialty: "Cardiology",
  decile: 5,
  eligiblePatients: 1000,
  brandSharePct: 0,
  trendPct: 0,
  seesReps: true,
  repTouchesQtr: 0,
  ...over,
});

// A pre-launch live cohort: share/trend/coverage identical for everyone; only volume varies.
const PRELAUNCH = [hcp("hcp_a", { eligiblePatients: 4000 }), hcp("hcp_b", { eligiblePatients: 2000 }), hcp("hcp_c", { eligiblePatients: 500 })];

describe("effectiveWeights (cohort-aware renormalization)", () => {
  it("renormalizes away signals that are uniform across the cohort", () => {
    const { weights, uniform } = effectiveWeights(PRELAUNCH, 4000);
    expect(uniform.sort()).toEqual(["trend", "whitespace"]);
    expect(weights.density).toBe(1);
    expect(weights.whitespace).toBe(0);
    expect(weights.trend).toBe(0);
  });

  it("keeps the base weights when every signal varies", () => {
    const varied = [hcp("hcp_a", { brandSharePct: 5, trendPct: 10, eligiblePatients: 3000 }), hcp("hcp_b", { brandSharePct: 30, trendPct: -4, eligiblePatients: 900 })];
    const { weights, uniform } = effectiveWeights(varied, 3000);
    expect(uniform).toEqual([]);
    expect(weights).toEqual({ whitespace: 0.45, density: 0.35, trend: 0.2 });
  });
});

describe("TargetingService with a pre-launch cohort", () => {
  const t = new TargetingService(PRELAUNCH, { densityRef: 4000 });

  it("scores become a clean volume ranking (top = 100) instead of a flat baseline", () => {
    const ranked = t.rank();
    expect(ranked[0]!.score).toBe(100);
    expect(ranked.map((r) => r.name)).toEqual(["Dr. hcp_a", "Dr. hcp_b", "Dr. hcp_c"]);
    expect(ranked[1]!.score).toBe(50);
  });

  it("components expose the honest breakdown (contributions sum to the score)", () => {
    const top = t.rank()[0]!;
    const sum = top.components.reduce((a, c) => a + c.contribution, 0);
    expect(Math.abs(sum - top.score)).toBeLessThan(0.2);
    const whitespace = top.components.find((c) => c.key === "whitespace")!;
    expect(whitespace.weight).toBe(0); // uniform pre-launch — renormalized away, shown as such
  });

  it("rationale explains the uniform pre-launch signals once instead of repeating constants", () => {
    const r = t.rank()[0]!.rationale.join(" ");
    expect(r).toMatch(/Pre-launch whitespace/);
    expect(r).not.toMatch(/\+0% QoQ/); // a constant 0 trend line is noise, not signal
  });

  it("cohort lookup tolerates the UI's stripped ids (the misattribution fix)", () => {
    expect(t.get("hcp_a")?.name).toBe("Dr. hcp_a");
    expect(t.get("a")?.name).toBe("Dr. hcp_a"); // drawer/invite links strip the prefix
    expect(t.has("nonexistent")).toBe(false);
  });
});

describe("scoreHcp with varied signals (post-launch shape)", () => {
  it("keeps share and trend lines in the rationale when they actually differentiate", () => {
    const varied = [hcp("hcp_a", { brandSharePct: 5, trendPct: 12 }), hcp("hcp_b", { brandSharePct: 30, trendPct: -2 })];
    const t = new TargetingService(varied, { densityRef: 1000 });
    const r = t.rank()[0]!.rationale.join(" ");
    expect(r).toMatch(/brand share/);
    expect(r).toMatch(/QoQ prescribing trend/);
    const s = scoreHcp(varied[0]!, { densityRef: 1000 });
    expect(s.components).toHaveLength(3);
  });
});
