/**
 * HCP audience provider contract. TargetingService depends only on HCPFeatures
 * (aggregate, no-PHI). Where those features come from — the DocNexus claims
 * backend or a modeled cohort — sits behind this interface, so switching to real
 * data is a config change, not a logic change (brief §19–20, CLAUDE.md adapters).
 */

import type { HCPFeatures } from "../index";

export interface AudienceQuery {
  /** Provider specialties to include (e.g. ["Cardiology", "Interventional Cardiology"]). */
  specialties: string[];
  /** ICD-10 diagnosis codes for the target indications (claims filter). */
  diagnosisCodes?: string[];
  /** Optional brand filter (rarely matches for an investigational compound). */
  drugBrandName?: string;
  limit?: number;
}

export interface AudienceProvider {
  readonly name: string;
  /** Returns aggregate HCP features for the cohort. Never returns PHI. */
  fetchCohort(query: AudienceQuery): Promise<HCPFeatures[]>;
}
