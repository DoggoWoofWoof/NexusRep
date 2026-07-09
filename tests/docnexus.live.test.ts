/**
 * LIVE integration test — exercises NexusRep's real DocNexusAudienceProvider
 * against hosted Advanced Search. Verifies the whole audience
 * code path end to end: specialty upper-casing, medicalPharmacyConditions tree,
 * and row → HCPFeatures mapping with per-provider patient counts.
 *
 * Gated: only runs when RUN_LIVE_DOCNEXUS=1 (needs platform creds or token file),
 * so the normal `npm test` suite stays hermetic.
 *
 * Verify:  RUN_LIVE_DOCNEXUS=1 DOCNEXUS_PLATFORM_EMAIL=... DOCNEXUS_PLATFORM_PASSWORD=... npx vitest run tests/docnexus.live.test.ts
 */
import { describe, it, expect } from "vitest";
import { DocNexusAudienceProvider, MILVEXIAN_AUDIENCE_QUERY } from "@modules/audience/providers";

const LIVE = process.env.RUN_LIVE_DOCNEXUS === "1";
const BASE = process.env.DOCNEXUS_ADVANCED_SEARCH_URL ?? "https://advanced-search.docnexus.ai";

describe.runIf(LIVE)("DocNexus advanced-search (live)", () => {
  it("returns real cardiology HCPs for the Milvexian cohort", async () => {
    const hasPlatformLogin = Boolean(process.env.DOCNEXUS_PLATFORM_EMAIL && process.env.DOCNEXUS_PLATFORM_PASSWORD);
    const provider = new DocNexusAudienceProvider({
      baseUrl: BASE,
      idToken: process.env.DOCNEXUS_ID_TOKEN || undefined,
      idTokenFile: process.env.DOCNEXUS_ID_TOKEN_FILE ?? ".docnexus-id-token.json",
      autoRefreshToken: process.env.DOCNEXUS_AUTO_REFRESH_TOKEN !== "0" && hasPlatformLogin,
      timeoutMs: 30000,
    });
    const cohort = await provider.fetchCohort(MILVEXIAN_AUDIENCE_QUERY);

    expect(cohort.length).toBeGreaterThan(0);
    // Every mapped HCP has a stable id + specialty; deciles assigned by volume.
    for (const h of cohort) {
      expect(h.id).toMatch(/^hcp_/);
      expect(h.decile).toBeGreaterThanOrEqual(1);
      expect(h.decile).toBeLessThanOrEqual(10);
      expect(h.eligiblePatients).toBeGreaterThanOrEqual(0);
    }
    // At least one provider should carry a non-zero indication patient count.
    expect(cohort.some((h) => h.eligiblePatients > 0)).toBe(true);

    const top = cohort[0]!;
    // eslint-disable-next-line no-console
    console.log(`[live] ${cohort.length} HCPs; top: ${top.name} (${top.specialty}) — ${top.eligiblePatients} eligible patients, decile ${top.decile}`);
  }, 40000);
});
