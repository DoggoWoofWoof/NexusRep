/**
 * Audience provider resolution. Chooses the DocNexus claims backend or the
 * modeled cohort from env, and exposes a fail-safe loader that always yields a
 * cohort (falling back to modeled data on any error) so the demo never breaks.
 */

import { env } from "@lib/env";
import type { HCPFeatures } from "../index";
import type { AudienceProvider, AudienceQuery } from "./types";
import { ModeledAudienceProvider, MILVEXIAN_COHORT } from "./modeled";
import { DocNexusAudienceProvider, type DocNexusConfig } from "./docnexus";
import { resolveDiagnosisCodes } from "./resolver";

export * from "./types";
export { ModeledAudienceProvider, MILVEXIAN_COHORT } from "./modeled";
export { DocNexusAudienceProvider, docnexusAuthHeaders, type DocNexusConfig } from "./docnexus";
export { resolveDiagnosisCodes } from "./resolver";

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

// The live claims backend is slow and its cost scales with the specialty × code cross-product
// (a 4-specialty cardiology query already takes ~21s). Cap both so an AI-derived query with many
// broad specialties/codes (e.g. Internal Medicine + 10 ICD codes) stays queryable instead of
// timing out. Order is preserved, so the Setup-AI's highest-priority specialties/codes win.
const MAX_QUERY_SPECIALTIES = 4;
const MAX_QUERY_DIAGNOSIS_CODES = 6;

/** Build the targeting query from the brand's clinical context. The Milvexian query is
 *  the fallback ONLY for profiles that don't declare their own targeting — a brand with
 *  specialties/diagnosisCodes set never inherits another brand's audience. */
export function audienceQueryFor(clinical?: { specialties?: string[]; diagnosisCodes?: string[] }): AudienceQuery {
  if (clinical?.specialties?.length || clinical?.diagnosisCodes?.length) {
    return {
      specialties: (clinical.specialties ?? []).slice(0, MAX_QUERY_SPECIALTIES),
      diagnosisCodes: (clinical.diagnosisCodes ?? []).slice(0, MAX_QUERY_DIAGNOSIS_CODES),
      limit: 50,
    };
  }
  return MILVEXIAN_AUDIENCE_QUERY;
}

/** The live DocNexus config, assembled from env once — shared by the cohort provider and the
 *  code resolver so both authenticate identically (Cognito refresh / API key / token file). */
export function docnexusConfigFromEnv(): DocNexusConfig {
  return {
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
  };
}

export function getAudienceProvider(): AudienceProvider {
  if (env.audienceProvider === "docnexus") return new DocNexusAudienceProvider(docnexusConfigFromEnv());
  return new ModeledAudienceProvider();
}

/**
 * Resolve free-text condition/indication terms (from Setup-AI extraction) to canonical ICD-10
 * codes via the live DocNexus resolver. Only attempts when the docnexus provider is configured;
 * returns [] otherwise (offline/modeled deployments keep whatever codes setup already holds).
 */
export async function resolveTargetingCodes(terms: string[]): Promise<string[]> {
  if (env.audienceProvider !== "docnexus" || !terms.length) return [];
  return resolveDiagnosisCodes(terms, docnexusConfigFromEnv());
}

export interface LoadedCohort {
  cohort: HCPFeatures[];
  source: string;
}

/** Process-wide cache of SUCCESSFUL live cohort loads, keyed by the exact query. The cohort is
 *  aggregate market data (non-PHI, identical for a given query), so with multi-user containers
 *  every user that resolves to the same targeting query reuses one fetch instead of re-hitting
 *  the claims backend per login. Fallbacks are NOT cached, so a degraded load still self-heals. */
const liveCohortCache = new Map<string, LoadedCohort>();
function cohortKey(q: AudienceQuery): string {
  return JSON.stringify({ s: q.specialties ?? [], d: q.diagnosisCodes ?? [], l: q.limit ?? null });
}

/** Load the targeting cohort, falling back to the modeled cohort on any failure.
 *  One retry before giving up: a cold-boot timeout or token refresh shouldn't silently
 *  swap the live claims cohort for sample data for the rest of the process lifetime. */
export async function loadCohort(query: AudienceQuery = MILVEXIAN_AUDIENCE_QUERY, attempts = 2): Promise<LoadedCohort> {
  const key = cohortKey(query);
  const cached = liveCohortCache.get(key);
  if (cached) return cached; // a prior live success for this exact query — reused across containers
  const provider = getAudienceProvider();
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      const cohort = await provider.fetchCohort(query);
      if (cohort.length) {
        const loaded = { cohort, source: provider.name };
        liveCohortCache.set(key, loaded); // cache only real successes; fallbacks stay retryable
        return loaded;
      }
      return { cohort: MILVEXIAN_COHORT, source: `${provider.name}(fallback:empty)` };
    } catch (e) {
      lastError = e;
      console.warn(`[audience] provider attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.warn("[audience] provider failed after retries, using modeled cohort:", lastError instanceof Error ? lastError.message : lastError);
  return { cohort: MILVEXIAN_COHORT, source: "modeled-cardiology(fallback:error)" };
}
