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

/** Build the targeting query from the brand's clinical context. The Milvexian query is
 *  the fallback ONLY for profiles that don't declare their own targeting — a brand with
 *  specialties/diagnosisCodes set never inherits another brand's audience. */
export function audienceQueryFor(clinical?: { specialties?: string[]; diagnosisCodes?: string[] }): AudienceQuery {
  if (clinical?.specialties?.length || clinical?.diagnosisCodes?.length) {
    return { specialties: clinical.specialties ?? [], diagnosisCodes: clinical.diagnosisCodes ?? [], limit: 50 };
  }
  return MILVEXIAN_AUDIENCE_QUERY;
}

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
      refreshToken: env.docnexusRefreshToken || undefined,
      cognitoClientId: env.docnexusCognitoClientId || undefined,
      cognitoRegion: env.docnexusCognitoRegion || undefined,
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

/** Load the targeting cohort, falling back to the modeled cohort on any failure.
 *  One retry before giving up: a cold-boot timeout or token refresh shouldn't silently
 *  swap the live claims cohort for sample data for the rest of the process lifetime. */
export async function loadCohort(query: AudienceQuery = MILVEXIAN_AUDIENCE_QUERY, attempts = 2): Promise<LoadedCohort> {
  const provider = getAudienceProvider();
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      const cohort = await provider.fetchCohort(query);
      if (cohort.length) return { cohort, source: provider.name };
      return { cohort: MILVEXIAN_COHORT, source: `${provider.name}(fallback:empty)` };
    } catch (e) {
      lastError = e;
      console.warn(`[audience] provider attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.warn("[audience] provider failed after retries, using modeled cohort:", lastError instanceof Error ? lastError.message : lastError);
  return { cohort: MILVEXIAN_COHORT, source: "modeled-cardiology(fallback:error)" };
}
