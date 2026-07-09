/**
 * Audience provider resolution. Chooses the DocNexus claims backend or the
 * modeled cohort from env, and exposes a fail-safe loader that always yields a
 * cohort (falling back to modeled data on any error) so the demo never breaks.
 */

import { env } from "@lib/env";
import type { HCPFeatures } from "../index";
import type { AudienceProvider, AudienceQuery } from "./types";
import { ModeledAudienceProvider, MILVEXIAN_COHORT } from "./modeled";
import { DocNexusAudienceProvider } from "./docnexus";

export * from "./types";
export { ModeledAudienceProvider, MILVEXIAN_COHORT } from "./modeled";
export { DocNexusAudienceProvider, type DocNexusConfig } from "./docnexus";

/**
 * The Milvexian targeting query: cardiology-family specialties treating the
 * LIBREXIA target indications (ACS I21/I24, atrial fibrillation I48, ischemic
 * stroke I63). Milvexian is investigational, so we target by indication volume,
 * not by brand.
 */
export const MILVEXIAN_AUDIENCE_QUERY: AudienceQuery = {
  specialties: ["Cardiology", "Interventional Cardiology", "Cardiac Electrophysiology", "Vascular Neurology"],
  diagnosisCodes: ["I48", "I21", "I24", "I63"],
  limit: 50,
};

export function getAudienceProvider(): AudienceProvider {
  if (env.audienceProvider === "docnexus") {
    return new DocNexusAudienceProvider({
      baseUrl: env.docnexusBaseUrl,
      apiKey: env.docnexusApiKey || undefined,
      idToken: env.docnexusIdToken || undefined,
      idTokenFile: env.docnexusIdTokenFile || undefined,
      autoRefreshToken: env.docnexusAutoRefreshToken,
      tokenRefreshScript: env.docnexusTokenRefreshScript,
      tokenRefreshTimeoutMs: env.docnexusTokenRefreshTimeoutMs,
      bearer: env.docnexusBearer || undefined,
      // Real claims aggregates over multiple specialties + indications take several
      // seconds; give generous headroom so we don't abort into the modeled fallback.
      timeoutMs: env.docnexusTimeoutMs,
    });
  }
  return new ModeledAudienceProvider();
}

export interface LoadedCohort {
  cohort: HCPFeatures[];
  source: string;
}

/** Load the targeting cohort, falling back to the modeled cohort on any failure. */
export async function loadCohort(query: AudienceQuery = MILVEXIAN_AUDIENCE_QUERY): Promise<LoadedCohort> {
  const provider = getAudienceProvider();
  try {
    const cohort = await provider.fetchCohort(query);
    if (cohort.length) return { cohort, source: provider.name };
    return { cohort: MILVEXIAN_COHORT, source: `${provider.name}(fallback:empty)` };
  } catch (e) {
    console.warn("[audience] provider failed, using modeled cohort:", e instanceof Error ? e.message : e);
    return { cohort: MILVEXIAN_COHORT, source: "modeled-cardiology(fallback:error)" };
  }
}
