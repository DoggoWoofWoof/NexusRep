/**
 * Audience / HCP targeting (brief §7, §16; PDF §10.1). Uses DocNexus
 * claims-derived HCP-level AGGREGATE features only — never raw patient-level
 * claims (hard rule). Wording avoids patient-level surveillance implications.
 *
 * The opportunity score is computed deterministically from aggregate features
 * (whitespace, eligible-patient density, prescribing trend) — not hand-set. The
 * vector index / LLM never see any of this; targeting is plain, auditable math.
 */

import type { HcpId, TargetListId } from "@lib/ids";

export type WhitespaceSegment = "no_rep" | "under_covered" | "no_see";

/** HCP-level aggregate features (claims-derived, no PHI). The scorer's inputs. */
export interface HCPFeatures {
  id: HcpId;
  name: string;
  specialty: string;
  /** 1–10 prescribing decile. */
  decile: number;
  /** Aggregate eligible-patient count for the indication (claims-derived). */
  eligiblePatients: number;
  /** Current brand share, 0–100. Low share + high density = whitespace. */
  brandSharePct: number;
  /** Quarter-over-quarter prescribing trend, percentage points. */
  trendPct: number;
  /** Whether the HCP sees field reps at all (drives the no_see segment). */
  seesReps: boolean;
  /** Field rep touches this quarter (0 = no current coverage). */
  repTouchesQtr: number;
}

export interface HCPOpportunityScore {
  hcpId: HcpId;
  name: string;
  specialty: string;
  decile: number;
  /** Aggregate eligible-patient count surfaced as a concise table value. */
  eligiblePatients: number;
  /** Current brand share percentage, kept separate from the concise UI count. */
  brandSharePct: number;
  /** 0–100 composite opportunity score (claims-derived aggregate). */
  score: number;
  whitespace: WhitespaceSegment;
  /** Aggregate, no-PHI phrasing for the UI. */
  eligiblePatientOpportunity: string;
  recommendedApprovedTopic: string;
  /** Plain-language reasons the score is what it is (for the drill-down). */
  rationale: string[];
}

export interface TargetList {
  id: TargetListId;
  hcpIds: HcpId[];
}

// Absolute density reference (a busy general-practice panel). Used when no cohort
// reference is supplied. For a PRE-LAUNCH / investigational drug the claims counts
// for the target indications are small in absolute terms, so the container passes a
// cohort-relative reference instead (the cohort's top density) — that turns the score
// into a meaningful RANKING within the target list rather than everyone flat-lining
// near the whitespace/trend baseline.
const DENSITY_REF = 3500;

const WEIGHTS = { whitespace: 0.45, density: 0.35, trend: 0.2 } as const;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Composite 0–100 opportunity score from aggregate features. Deterministic.
 * `densityRef` scales the eligible-patient signal: omit it for an absolute score,
 * or pass the cohort's top density so the score reflects standing WITHIN the cohort.
 */
export function scoreOpportunity(f: HCPFeatures, opts?: { densityRef?: number }): number {
  const ref = opts?.densityRef && opts.densityRef > 0 ? opts.densityRef : DENSITY_REF;
  const whitespaceScore = clamp01((100 - f.brandSharePct) / 100);
  const densityScore = clamp01(f.eligiblePatients / ref);
  const trendScore = clamp01((f.trendPct + 10) / 30); // maps −10…+20pp → 0…1
  const composite =
    WEIGHTS.whitespace * whitespaceScore + WEIGHTS.density * densityScore + WEIGHTS.trend * trendScore;
  return Math.round(composite * 1000) / 10; // one decimal, 0–100
}

/** Whitespace segment from coverage features (no patient-level inference). */
export function whitespaceOf(f: HCPFeatures): WhitespaceSegment {
  if (!f.seesReps) return "no_see";
  if (f.repTouchesQtr === 0) return "no_rep";
  return "under_covered";
}

/** Per-brand targeting config (topics + indication label) — from the active BrandProfile. */
export interface TargetingConfig {
  recommendedTopics?: { trendNegative: string; lowShare: string; default: string };
  indicationLabel?: string;
  /** Cohort's top eligible-patient density — makes the score a within-cohort ranking. */
  densityRef?: number;
}

const DEFAULT_TOPICS = { trendNegative: "Development & status", lowShare: "Mechanism of action", default: "Program overview" };

/**
 * Choose the public-info topic to lead with, from the brand's topics. Differentiates by the
 * signals that actually vary: a declining prescriber gets a status update; a high-decile
 * (high-volume) prescriber is ready for program depth; everyone else gets mechanism awareness.
 * (Brand share is uniform ~0 pre-launch, so it can't drive this — decile/trend do.)
 */
function recommendedTopic(f: HCPFeatures, topics = DEFAULT_TOPICS): string {
  if (f.trendPct < 0) return topics.trendNegative;
  if (f.decile <= 2) return topics.default;
  return topics.lowShare;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function scoreHcp(f: HCPFeatures, cfg?: TargetingConfig): HCPOpportunityScore {
  const segment = whitespaceOf(f);
  const segmentLabel: Record<WhitespaceSegment, string> = {
    no_rep: "no current rep coverage",
    under_covered: "under-covered",
    no_see: "no-see (rep-averse)",
  };
  const indicationLabel = cfg?.indicationLabel ?? "the target indication";
  return {
    hcpId: f.id,
    name: f.name,
    specialty: f.specialty,
    decile: f.decile,
    eligiblePatients: f.eligiblePatients,
    brandSharePct: f.brandSharePct,
    score: scoreOpportunity(f, { densityRef: cfg?.densityRef }),
    whitespace: segment,
    eligiblePatientOpportunity: `${fmt(f.eligiblePatients)} eligible patients · ${f.brandSharePct}% brand share (claims-derived, no PHI)`,
    recommendedApprovedTopic: recommendedTopic(f, cfg?.recommendedTopics),
    rationale: [
      `Eligible-patient density ${fmt(f.eligiblePatients)} in region for ${indicationLabel}.`,
      `Prescribing whitespace: ${f.brandSharePct}% brand share, ${segmentLabel[segment]}.`,
      `${f.trendPct >= 0 ? "+" : ""}${f.trendPct}% QoQ trend, decile ${f.decile}.`,
    ],
  };
}

/**
 * Computes and ranks opportunity scores for a cohort. Constructed with the
 * aggregate feature set (from the DocNexus claims adapter in production; seeded
 * for the demo). Business logic only — no store, no vendor payloads.
 */
export class TargetingService {
  constructor(private readonly features: HCPFeatures[], private readonly cfg?: TargetingConfig) {}

  /** All HCPs, highest opportunity first. */
  rank(): HCPOpportunityScore[] {
    return this.features.map((f) => scoreHcp(f, this.cfg)).sort((a, b) => b.score - a.score);
  }

  /** Top-N target list. */
  top(n: number): HCPOpportunityScore[] {
    return this.rank().slice(0, n);
  }

  /** Count of high-opportunity HCPs at or above a score threshold. */
  highOpportunityCount(threshold = 75): number {
    return this.rank().filter((h) => h.score >= threshold).length;
  }

  /** Average composite opportunity score across the cohort (one decimal). */
  averageScore(): number {
    if (this.features.length === 0) return 0;
    const sum = this.rank().reduce((a, h) => a + h.score, 0);
    return Math.round((sum / this.features.length) * 10) / 10;
  }

  /** Total claims-derived eligible-patient opportunity across the cohort (aggregate). */
  totalEligiblePatients(): number {
    return this.features.reduce((a, f) => a + f.eligiblePatients, 0);
  }

  cohortSize(): number {
    return this.features.length;
  }

  /** Count of HCPs in each whitespace segment. */
  segmentCounts(): Record<WhitespaceSegment, number> {
    const counts: Record<WhitespaceSegment, number> = { no_rep: 0, under_covered: 0, no_see: 0 };
    for (const f of this.features) counts[whitespaceOf(f)] += 1;
    return counts;
  }
}

export {
  getAudienceProvider,
  loadCohort,
  MILVEXIAN_COHORT,
  MILVEXIAN_AUDIENCE_QUERY,
  DocNexusAudienceProvider,
  ModeledAudienceProvider,
  type AudienceProvider,
  type AudienceQuery,
  type LoadedCohort,
} from "./providers";
