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
  /** NPI when the claims source provides one — used for CRM identity resolution.
   *  Absent → CRM outbox surfaces "needs_mapping" (the real unresolved-identity state). */
  npi?: string;
}

/** One signal's contribution to the composite score — the honest breakdown the UI shows. */
export interface ScoreComponent {
  key: "whitespace" | "density" | "trend";
  label: string;
  /** Effective weight for THIS cohort (a uniform pre-launch signal renormalizes to 0). */
  weight: number;
  /** Normalized 0–1 signal value for this HCP. */
  value01: number;
  /** weight x value x 100 — the points this signal adds to the 0–100 score. */
  contribution: number;
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
  /** Per-signal breakdown: exactly how the score was computed (auditable math, no black box). */
  components: ScoreComponent[];
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
export type ScoreWeights = { whitespace: number; density: number; trend: number };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** The three normalized 0–1 signals the composite is built from. */
function signalValues(f: HCPFeatures, densityRef: number): ScoreWeights {
  return {
    whitespace: clamp01((100 - f.brandSharePct) / 100),
    density: clamp01(f.eligiblePatients / densityRef),
    trend: clamp01((f.trendPct + 10) / 30), // maps -10..+20pp -> 0..1
  };
}

/**
 * Cohort-aware weights: a signal that is IDENTICAL for every HCP in the cohort (e.g.
 * brand share and trend are all 0 for a pre-launch drug with no coverage feed) cannot
 * rank anyone — its weight renormalizes across the signals that actually vary, so the
 * score is an honest ranking instead of a constant baseline dressed up as 3 signals.
 * Returns the base weights untouched when everything varies (or nothing does).
 */
export function effectiveWeights(features: HCPFeatures[], densityRef?: number): { weights: ScoreWeights; uniform: (keyof ScoreWeights)[] } {
  if (features.length < 2) return { weights: { ...WEIGHTS }, uniform: [] };
  const ref = densityRef && densityRef > 0 ? densityRef : DENSITY_REF;
  const values = features.map((f) => signalValues(f, ref));
  const keys: (keyof ScoreWeights)[] = ["whitespace", "density", "trend"];
  const uniform = keys.filter((k) => {
    const first = values[0]![k];
    return values.every((v) => Math.abs(v[k] - first) < 1e-6);
  });
  if (uniform.length === 0 || uniform.length === keys.length) return { weights: { ...WEIGHTS }, uniform: uniform.length === keys.length ? uniform : [] };
  const varying = keys.filter((k) => !uniform.includes(k));
  const varyingTotal = varying.reduce((a, k) => a + WEIGHTS[k], 0);
  const weights = { whitespace: 0, density: 0, trend: 0 };
  for (const k of varying) weights[k] = WEIGHTS[k] / varyingTotal;
  return { weights, uniform };
}

/**
 * Composite 0–100 opportunity score from aggregate features. Deterministic.
 * `densityRef` scales the eligible-patient signal: omit it for an absolute score,
 * or pass the cohort's top density so the score reflects standing WITHIN the cohort.
 */
export function scoreOpportunity(f: HCPFeatures, opts?: { densityRef?: number; weights?: ScoreWeights }): number {
  const ref = opts?.densityRef && opts.densityRef > 0 ? opts.densityRef : DENSITY_REF;
  const w = opts?.weights ?? WEIGHTS;
  const v = signalValues(f, ref);
  const composite = w.whitespace * v.whitespace + w.density * v.density + w.trend * v.trend;
  return Math.round(composite * 1000) / 10; // one decimal, 0-100
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
  /** Cohort-effective weights (from effectiveWeights). Defaults to the base weights. */
  weights?: ScoreWeights;
  /** Signals uniform across the cohort (pre-launch) — rationale explains instead of repeating them. */
  uniformSignals?: (keyof ScoreWeights)[];
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
  const ref = cfg?.densityRef && cfg.densityRef > 0 ? cfg.densityRef : DENSITY_REF;
  const w = cfg?.weights ?? WEIGHTS;
  const v = signalValues(f, ref);
  const uniform = new Set(cfg?.uniformSignals ?? []);
  const componentDefs: { key: ScoreComponent["key"]; label: string }[] = [
    { key: "whitespace", label: "Prescribing whitespace" },
    { key: "density", label: "Eligible-patient volume" },
    { key: "trend", label: "Prescribing trend" },
  ];
  const components: ScoreComponent[] = componentDefs.map(({ key, label }) => ({
    key,
    label,
    weight: Math.round(w[key] * 100) / 100,
    value01: Math.round(v[key] * 100) / 100,
    contribution: Math.round(w[key] * v[key] * 1000) / 10,
  }));

  // Rationale leads with what actually ranks this doctor; signals that are uniform across
  // the cohort get ONE honest explanation instead of repeating a constant per doctor.
  const rationale: string[] = [
    `${fmt(f.eligiblePatients)} eligible patients for ${indicationLabel} — decile ${f.decile} by volume in this cohort.`,
  ];
  if (uniform.has("whitespace")) {
    rationale.push(`Pre-launch whitespace: 0% brand share and ${segmentLabel[segment]} — true for the whole cohort, so ranking comes from the signals that differ.`);
  } else {
    rationale.push(`Prescribing whitespace: ${f.brandSharePct}% brand share, ${segmentLabel[segment]}.`);
  }
  if (!uniform.has("trend")) {
    rationale.push(`${f.trendPct >= 0 ? "+" : ""}${f.trendPct}% QoQ prescribing trend.`);
  }

  return {
    hcpId: f.id,
    name: f.name,
    specialty: f.specialty,
    decile: f.decile,
    eligiblePatients: f.eligiblePatients,
    brandSharePct: f.brandSharePct,
    score: scoreOpportunity(f, { densityRef: cfg?.densityRef, weights: w }),
    whitespace: segment,
    eligiblePatientOpportunity: `${fmt(f.eligiblePatients)} eligible patients · ${f.brandSharePct}% brand share (claims-derived, no PHI)`,
    recommendedApprovedTopic: recommendedTopic(f, cfg?.recommendedTopics),
    rationale,
    components,
  };
}

/**
 * Computes and ranks opportunity scores for a cohort. Constructed with the
 * aggregate feature set (from the DocNexus claims adapter in production; seeded
 * for the demo). Business logic only — no store, no vendor payloads.
 */
export class TargetingService {
  private cfg?: TargetingConfig;
  private features: HCPFeatures[];

  constructor(features: HCPFeatures[], cfg?: TargetingConfig) {
    this.features = features;
    // Resolve cohort-effective weights ONCE: uniform pre-launch signals renormalize away,
    // so scores rank by what actually differs (and the rationale says so).
    const { weights, uniform } = effectiveWeights(features, cfg?.densityRef);
    this.cfg = { ...cfg, weights: cfg?.weights ?? weights, uniformSignals: cfg?.uniformSignals ?? uniform };
  }

  /** The signals that were uniform across this cohort (surfaced by the audience API). */
  uniformSignals(): (keyof ScoreWeights)[] {
    return [...(this.cfg?.uniformSignals ?? [])];
  }

  /**
   * Swap the cohort IN PLACE (weights, uniform signals and density reference recomputed) —
   * used when the live claims source recovers after a boot-time fallback. Every service
   * holding this instance (analytics, identity checks, npi resolution) sees the new cohort
   * without being rebuilt.
   */
  replaceCohort(features: HCPFeatures[]): void {
    this.features = features;
    const maxDensity = features.reduce((m, f) => Math.max(m, f.eligiblePatients), 0);
    const densityRef = maxDensity > 0 ? maxDensity : this.cfg?.densityRef;
    const { weights, uniform } = effectiveWeights(features, densityRef);
    this.cfg = { ...this.cfg, densityRef, weights, uniformSignals: uniform };
  }

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

  /** Look up one cohort member by id — the identity check conversation routes use so a
   *  client-supplied hcpId can only ever resolve to a real targeted HCP (never invent one).
   *  Prefix-tolerant: UI surfaces strip the canonical "hcp_" prefix from ids (drawer,
   *  invite links), and that stripped form silently fell back to the demo identity. */
  get(hcpId: string): HCPFeatures | undefined {
    const wanted = String(hcpId ?? "").trim();
    if (!wanted) return undefined;
    return this.features.find((f) => String(f.id) === wanted || String(f.id) === `hcp_${wanted}`);
  }

  has(hcpId: string): boolean {
    return this.get(hcpId) !== undefined;
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
  loadCohort, audienceQueryFor,
  MILVEXIAN_COHORT,
  MILVEXIAN_AUDIENCE_QUERY,
  DocNexusAudienceProvider,
  ModeledAudienceProvider,
  type AudienceProvider,
  type AudienceQuery,
  type LoadedCohort,
} from "./providers";
