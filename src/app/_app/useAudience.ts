"use client";

import { useEffect, useState } from "react";
import { HCPS, type Hcp, type SegTone } from "./data";

type HCPOpportunityScore = {
  hcpId: string;
  name: string;
  specialty: string;
  decile: number;
  eligiblePatients: number;
  brandSharePct: number;
  score: number;
  whitespace: "no_rep" | "under_covered" | "no_see";
  eligiblePatientOpportunity: string;
  recommendedApprovedTopic: string;
  rationale: string[];
  components?: { key: string; label: string; weight: number; value01: number; contribution: number }[];
};
type AudienceSummary = {
  highOpportunity: number;
  averageScore: number;
  eligiblePatients: number;
  cohortSize: number;
  segments: { no_rep: number; under_covered: number; no_see: number };
};
type AudienceResponse = { source: string; degraded?: boolean; summary: AudienceSummary; rows: HCPOpportunityScore[] };

const WHITESPACE_MAP: Record<HCPOpportunityScore["whitespace"], { segment: string; segTone: SegTone }> = {
  no_rep: { segment: "No-rep whitespace", segTone: "green" },
  under_covered: { segment: "Under-covered", segTone: "yellow" },
  no_see: { segment: "No-see", segTone: "pink" },
};

function mapHcp(r: HCPOpportunityScore, i: number): Hcp {
  const w = WHITESPACE_MAP[r.whitespace] ?? WHITESPACE_MAP.no_rep;
  return {
    id: r.hcpId.replace(/^hcp_/, ""),
    rank: i + 1,
    name: r.name,
    specialty: r.specialty,
    institution: w.segment,
    decile: "D" + r.decile,
    segment: w.segment,
    segTone: w.segTone,
    patients: r.eligiblePatients.toLocaleString("en-US"),
    score: r.score.toFixed(1),
    trend: "",
    up: true,
    topic: r.recommendedApprovedTopic,
    rationale: r.rationale,
    // The REAL score decomposition (weight x signal = points) — replaces the old
    // fabricated "content affinity" percentages derived from the score.
    scoreParts: (r.components ?? []).map((cmp) => ({
      label: cmp.label,
      pct: cmp.weight === 0 ? 0 : Math.round(cmp.value01 * 100),
      note: cmp.weight === 0 ? "uniform pre-launch — not ranking" : `+${cmp.contribution.toFixed(1)} pts · ${Math.round(cmp.weight * 100)}% weight`,
    })),
  };
}

export function useAudience(): { rows: Hcp[]; summary: AudienceSummary | null; live: boolean; degraded: boolean } {
  const [rows, setRows] = useState<Hcp[]>(HCPS);
  const [summary, setSummary] = useState<AudienceSummary | null>(null);
  // false → the fixture list is showing (API failed / not yet loaded). Screens surface this
  // as a "sample data" banner so canned doctors are never mistaken for the real cohort.
  const [live, setLive] = useState(false);
  // true → the server itself fell back to the MODELED cohort (live claims unreachable at
  // boot). The API retries automatically; the banner keeps the degradation visible.
  const [degraded, setDegraded] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/audience");
        if (!res.ok) return;
        const json = (await res.json()) as AudienceResponse;
        if (!alive) return;
        // A successful response IS the real cohort — adopt it even when empty. An unconfigured
        // brand (no targeting yet) legitimately has zero doctors; keeping the canned fixture there
        // would show another brand's cardiology sample as if it were this rep's audience.
        setRows((json.rows ?? []).map(mapHcp));
        setLive(true);
        setDegraded(Boolean(json.degraded) || String(json.source ?? "").includes("fallback"));
        if (json.summary) setSummary(json.summary);
      } catch {
        /* keep static fallback — labeled as sample data by the caller */
      }
    })();
    return () => { alive = false; };
  }, []);
  return { rows, summary, live, degraded };
}

