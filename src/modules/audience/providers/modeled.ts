/**
 * Modeled cardiology cohort for the Milvexian (investigational Factor XIa
 * inhibitor) demo — the fallback when the DocNexus backend isn't configured or
 * reachable. Features are illustrative AGGREGATES (no PHI): eligible-patient
 * density for the LIBREXIA target indications (ACS, atrial fibrillation,
 * ischemic stroke), current anticoagulant-class engagement (a whitespace proxy),
 * and diagnosis-volume trend. Milvexian itself is pre-launch, so no brand share.
 */

import { asId } from "@lib/ids";
import type { HcpId } from "@lib/ids";
import type { HCPFeatures } from "../index";
import type { AudienceProvider, AudienceQuery } from "./types";

const h = (id: string) => asId<"hcp_id">(id) as HcpId;

/** Illustrative cardiology cohort keyed by stable ids (also the demo directory). */
export const MILVEXIAN_COHORT: HCPFeatures[] = [
  { id: h("hcp_okafor"), name: "Dr. M. Okafor", specialty: "Cardiac Electrophysiology", decile: 2, eligiblePatients: 3480, brandSharePct: 5, trendPct: 14, seesReps: true, repTouchesQtr: 0 },
  { id: h("hcp_sharma"), name: "Dr. A. Sharma", specialty: "Interventional Cardiology", decile: 3, eligiblePatients: 3120, brandSharePct: 8, trendPct: 16, seesReps: true, repTouchesQtr: 1 },
  { id: h("hcp_haddad"), name: "Dr. S. Haddad", specialty: "Interventional Cardiology", decile: 2, eligiblePatients: 2980, brandSharePct: 7, trendPct: 9, seesReps: true, repTouchesQtr: 0 },
  { id: h("hcp_nguyen"), name: "Dr. R. Nguyen", specialty: "Vascular Neurology", decile: 3, eligiblePatients: 2640, brandSharePct: 10, trendPct: 21, seesReps: true, repTouchesQtr: 1 },
  { id: h("hcp_castellano"), name: "Dr. L. Castellano", specialty: "Cardiology", decile: 4, eligiblePatients: 2210, brandSharePct: 24, trendPct: 7, seesReps: true, repTouchesQtr: 2 },
  { id: h("hcp_volkova"), name: "Dr. E. Volkova", specialty: "Cardiac Electrophysiology", decile: 4, eligiblePatients: 1890, brandSharePct: 19, trendPct: 5, seesReps: true, repTouchesQtr: 2 },
  { id: h("hcp_whitfield"), name: "Dr. J. Whitfield", specialty: "Cardiology", decile: 6, eligiblePatients: 1120, brandSharePct: 14, trendPct: 2, seesReps: true, repTouchesQtr: 3 },
  { id: h("hcp_andersson"), name: "Dr. P. Andersson", specialty: "Cardiology", decile: 5, eligiblePatients: 1580, brandSharePct: 33, trendPct: -2, seesReps: false, repTouchesQtr: 0 },
];

export class ModeledAudienceProvider implements AudienceProvider {
  readonly name = "modeled-cardiology";
  async fetchCohort(query: AudienceQuery): Promise<HCPFeatures[]> {
    const wanted = new Set(query.specialties.map((s) => s.toLowerCase()));
    const rows = wanted.size
      ? MILVEXIAN_COHORT.filter((f) => wanted.has(f.specialty.toLowerCase()) || matchesFamily(f.specialty, wanted))
      : MILVEXIAN_COHORT;
    const list = rows.length ? rows : MILVEXIAN_COHORT;
    return query.limit ? list.slice(0, query.limit) : list;
  }
}

/** Treat cardiology sub-specialties as matching a broad "cardiology" request. */
function matchesFamily(specialty: string, wanted: Set<string>): boolean {
  const s = specialty.toLowerCase();
  return wanted.has("cardiology") && (s.includes("cardio") || s.includes("electrophysiology"));
}
