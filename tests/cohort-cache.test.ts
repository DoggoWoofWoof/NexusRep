/**
 * With multi-user containers, every user that resolves to the same targeting query used to
 * re-hit the claims backend on login (multiplying timeouts / "operation aborted" warnings).
 * The cohort is aggregate market data, so a successful load is cached per-query and reused.
 */

import { describe, expect, it } from "vitest";
import { loadCohort } from "@modules/audience";

describe("cohort load cache (shared across per-user containers)", () => {
  it("reuses a successful load for the same query instead of re-fetching", async () => {
    // Test env has no DocNexus credential → the modeled provider returns a non-empty cohort,
    // which is a "success" and therefore cached.
    const query = { specialties: ["Cardiology"], diagnosisCodes: ["I48"], limit: 50 };
    const first = await loadCohort(query);
    const second = await loadCohort(query);
    expect(first.cohort.length).toBeGreaterThan(0);
    expect(second).toBe(first); // identical cached result — no second backend call
  });
});
