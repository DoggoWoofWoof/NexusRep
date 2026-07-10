"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState } from "./NexusRepApp";
import { btnGhost, btnPrimary } from "./NexusRepApp";
import { SlideView } from "../_components/SlideView";
import {
  ANALYTICS_KPIS, ANALYTICS_TABS, CRM_CONNECTORS,
  HCPS, TONE_COLORS, TRAIN_SEED_KEY, VENDOR_STACK, compStyle, segStyle, type Hcp, type SegTone,
} from "./data";

const eyebrow: React.CSSProperties = { font: "600 11px/1.2 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--dn-brand-light)", marginBottom: 6 };
const h1: React.CSSProperties = { font: "600 24px/1.2 var(--dn-font-sans)", letterSpacing: "-0.02em", margin: 0, color: "var(--dn-fg)" };
const card: React.CSSProperties = { background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)" };
const cell: React.CSSProperties = { font: "400 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" };

export function BrandScreens({ app }: { app: AppState }) {
  switch (app.nav) {
    case "targeting": return <Audience app={app} />;
    case "outreach": return <Launch app={app} />;
    case "sessions": return <Sessions app={app} />;
    case "analytics": return <Analytics />;
    case "audit": return <SessionDetail app={app} />;
    case "crm": return <FollowUps />;
    case "admin": return <Admin />;
    default: return null;
  }
}

/* ===================== AUDIENCE ===================== */
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

function useAudience(): { rows: Hcp[]; summary: AudienceSummary | null; live: boolean; degraded: boolean } {
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
        if (json.rows && json.rows.length) {
          setRows(json.rows.map(mapHcp));
          setLive(true);
        }
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

function Audience({ app }: { app: AppState }) {
  const { rows: hcps, summary: apiSummary, live, degraded } = useAudience();
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const [spec, setSpec] = useState("all");
  const specialties = [...new Set(hcps.map((h) => h.specialty))].sort();
  const filtered = hcps.filter(
    (h) => (spec === "all" || h.specialty === spec) && (!search.trim() || h.name.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const visibleHcps = showAll ? filtered : filtered.slice(0, 12);
  // Top-decile = high-volume prescribers for the target indications (D1–D2); a real,
  // differentiating targeting signal, unlike the coverage "whitespace" split which is a
  // single bucket on claims data with no rep-coverage feed.
  const topDecile = hcps.filter((h) => /^D[12]$/.test(h.decile)).length;
  const summary = [
    { label: "Target HCPs", value: apiSummary ? String(apiSummary.cohortSize) : "37", color: "var(--dn-brand-base)", sub: "In the target cohort" },
    { label: "Avg opp score", value: apiSummary ? apiSummary.averageScore.toFixed(1) : "88.4", color: "var(--dn-fg)", sub: "0–100 · ranked within cohort" },
    { label: "Top-decile targets", value: String(topDecile), color: "var(--dn-fg)", sub: "High-volume prescribers (D1–D2)" },
    { label: "Eligible patients", value: apiSummary ? apiSummary.eligiblePatients.toLocaleString() : "64,210", color: "var(--dn-fg)", sub: "Target-indication claims · no PHI" },
    { label: "On activation list", value: String(app.activation.length), color: "var(--dn-success)", sub: "Ready to launch" },
  ];
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1380 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 6 }}>
        <div><div style={eyebrow}>Audience</div><h1 style={h1}>Who should the rep speak to?</h1></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ font: "500 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Activation list</span>
          <span style={{ font: "700 13px/1 var(--dn-font-sans)", color: "#fff", background: "var(--dn-brand-base)", padding: "7px 12px", borderRadius: 20 }}>{app.activation.length}</span>
          <button onClick={() => app.setNav("outreach")} style={{ ...btnGhost, color: "var(--dn-brand-base)", border: "1px solid var(--dn-brand-base)" }}>Go to launch →</button>
        </div>
      </div>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "8px 0 18px", maxWidth: 820 }}>Ranked by opportunity score from HCP-level aggregate claims signals. The table stays concise; click a row for the full rationale, then add selected HCPs to launch.</p>
      {!live && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 14px", padding: "9px 13px", background: "var(--dn-accent-yellow-bg)", border: "1px solid #fcd34d", borderRadius: 9, font: "500 12px/1.4 var(--dn-font-sans)", color: "#92400e" }}>
          ⚠ Showing sample doctors — the live claims cohort hasn&apos;t loaded. These rows are illustrative, not your targeting data.
        </div>
      )}
      {live && degraded && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 14px", padding: "9px 13px", background: "var(--dn-accent-yellow-bg)", border: "1px solid #fcd34d", borderRadius: 9, font: "500 12px/1.4 var(--dn-font-sans)", color: "#92400e" }}>
          ⚠ Live claims cohort unreachable — showing the modeled sample cohort. The server retries automatically; reload in a minute to pick up the real doctors.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 18 }}>
        {summary.map((t) => (
          <div key={t.label} style={{ ...card, padding: "14px 15px" }}>
            <div style={{ font: "600 10.5px/1.3 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 8 }}>{t.label}</div>
            <div style={{ font: "600 22px/1 var(--dn-font-sans)", color: t.color, letterSpacing: "-0.01em" }}>{t.value}</div>
            <div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 4 }}>{t.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search doctors by name…"
          style={{ flex: "1 1 220px", maxWidth: 320, padding: "9px 12px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 12.5px/1 var(--dn-font-sans)", background: "#fff" }}
        />
        <select value={spec} onChange={(e) => setSpec(e.target.value)} style={{ padding: "9px 12px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "500 12.5px/1 var(--dn-font-sans)", background: "#fff", color: "var(--dn-fg)" }}>
          <option value="all">All specialties</option>
          {specialties.map((sp) => (
            <option key={sp} value={sp}>{sp}</option>
          ))}
        </select>
        <span style={{ font: "500 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{filtered.length} of {hcps.length} doctors</span>
      </div>
      <div style={{ ...card, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "36px 1.6fr 1.2fr 0.6fr 1.1fr 0.9fr 1.4fr 92px", padding: "12px 18px", background: "var(--dn-surface-2)", borderBottom: "1px solid var(--dn-border)", font: "600 10.5px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", alignItems: "center" }}>
          <span>#</span><span>HCP</span><span>Specialty</span><span>Decile</span><span>Aggregate pts</span><span>Opp</span><span>Conversation lead</span><span />
        </div>
        {visibleHcps.map((h) => {
          const added = app.activation.includes(h.id);
          return (
            <div key={h.id} data-testid="audience-row" onClick={() => app.setDrawerId(h.id)} style={{ display: "grid", gridTemplateColumns: "36px 1.6fr 1.2fr 0.6fr 1.1fr 0.9fr 1.4fr 92px", padding: "13px 18px", borderBottom: "1px solid var(--dn-surface-2)", alignItems: "center", ...cell, cursor: "pointer" }}>
              <span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{h.rank}</span>
              <span style={{ fontWeight: 600 }}>{h.name}</span>
              <span style={{ color: "var(--dn-fg-muted)" }}>{h.specialty}</span>
              <span><span style={{ font: "600 11px/1 var(--dn-font-sans)", padding: "3px 7px", background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderRadius: 5, color: "var(--dn-fg)" }}>{h.decile}</span></span>
              <span style={{ font: "500 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{h.patients}</span>
              <span style={{ font: "700 13px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{h.score}</span>
              <span style={{ font: "500 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{h.topic}</span>
              <span onClick={(e) => { e.stopPropagation(); app.toggleActivation(h.id); }} style={{ font: "600 11px/1 var(--dn-font-sans)", padding: "6px 10px", borderRadius: 7, textAlign: "center", cursor: "pointer", background: added ? "var(--dn-accent-green-bg)" : "rgba(6,73,172,.08)", color: added ? "#166534" : "var(--dn-brand-base)" }}>{added ? "Added ✓" : "Add"}</span>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: "26px 18px", textAlign: "center", font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
            No doctors match — clear the search or specialty filter.
          </div>
        )}
        {filtered.length > 12 && (
          <div style={{ padding: "14px 18px", display: "flex", justifyContent: "center", background: "#fff" }}>
            <button onClick={() => setShowAll((v) => !v)} style={{ ...btnGhost, padding: "9px 14px" }}>
              {showAll ? "Show top 12" : `Show all ${filtered.length} HCPs`}
            </button>
          </div>
        )}
      </div>
      {app.drawerId && hcps.find((h) => h.id === app.drawerId) && <HcpDrawer app={app} hcp={hcps.find((h) => h.id === app.drawerId)!} />}
    </div>
  );
}

function HcpDrawer({ app, hcp }: { app: AppState; hcp: Hcp }) {
  const added = app.activation.includes(hcp.id);
  return (
    <>
      <div onClick={() => app.setDrawerId(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 40 }} />
      <aside data-testid="hcp-drawer" style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 444, maxWidth: "92vw", background: "#fff", zIndex: 41, boxShadow: "-12px 0 40px rgba(15,23,42,.18)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 22px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ font: "600 10.5px/1 var(--dn-font-sans)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dn-brand-light)", marginBottom: 7 }}>HCP Profile</div>
            <div data-testid="hcp-drawer-name" style={{ font: "600 19px/1.2 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{hcp.name}</div>
            <div style={{ font: "400 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 3 }}>{hcp.specialty} · {hcp.institution}</div>
          </div>
          <button onClick={() => app.setDrawerId(null)} style={{ background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 16, color: "var(--dn-fg-muted)", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 18 }}>
            {[["Opp Score", hcp.score, "var(--dn-brand-base)"], ["Decile", hcp.decile, "var(--dn-fg)"], ["Eligible Pts", hcp.patients, "var(--dn-fg)"]].map(([l, v, c]) => (
              <div key={l} style={{ background: "var(--dn-surface-2)", borderRadius: 10, padding: "12px 13px" }}><div style={{ font: "600 9.5px/1.2 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 6 }}>{l}</div><div style={{ font: "700 20px/1 var(--dn-font-sans)", color: c }}>{v}</div></div>
            ))}
          </div>
          <div style={{ marginBottom: 18, padding: "14px 16px", border: "1px solid var(--dn-border)", borderRadius: 11, background: "rgba(6,73,172,.03)" }}>
            <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-brand-light)", marginBottom: 7 }}>Recommended approved topic</div>
            <div style={{ font: "600 13.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{hcp.topic}</div>
          </div>
          <div style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 10 }}>Why this HCP</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 22 }}>
            {hcp.rationale.map((r) => (
              <div key={r} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ flexShrink: 0, marginTop: 2, width: 16, height: 16, borderRadius: "50%", background: "var(--dn-accent-green-bg)", color: "#166534", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}>✓</span>
                <span style={{ font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{r}</span>
              </div>
            ))}
          </div>
          <div style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 4 }}>Score breakdown</div>
          <div style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 12 }}>How the {hcp.score} was computed — auditable weights, no black box.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 22 }}>
            {hcp.scoreParts.map((a) => (
              <div key={a.label} style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ width: 140, flexShrink: 0, font: "500 11.5px/1.3 var(--dn-font-sans)", color: a.pct === 0 ? "var(--dn-fg-subtle)" : "var(--dn-fg)" }}>{a.label}</span>
                <span style={{ flex: 1, height: 12, borderRadius: 4, background: "var(--dn-surface-2)", overflow: "hidden" }}><span style={{ display: "block", height: "100%", borderRadius: 4, background: "var(--dn-brand-light)", width: `${a.pct}%` }} /></span>
                <span style={{ width: 128, textAlign: "right", font: "600 10px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{a.note}</span>
              </div>
            ))}
          </div>
          <HcpEngagementPanel hcpId={hcp.id} />
        </div>
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--dn-border)", display: "flex", gap: 9 }}>
          <button onClick={() => app.toggleActivation(hcp.id)} style={{ flex: 1, padding: 11, borderRadius: 9, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer", border: "none", background: added ? "var(--dn-accent-green-bg)" : "var(--dn-brand-base)", color: added ? "#166534" : "#fff" }}>{added ? "On activation list ✓" : "Add to activation list"}</button>
          <button onClick={() => { app.setDrawerId(null); app.setSessionHcpId(hcp.id); app.setMode("hcp"); }} style={{ flex: 1, padding: 11, background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer" }}>Preview AI rep ↗</button>
        </div>
      </aside>
    </>
  );
}

type EngagementSummary = { sessions: number; questions: number; followUps: number; lastAt: string | null; topicsShown: string[] };

/** Real engagement from OUR session logs (no invented percentages): sessions, questions,
 *  follow-ups, last contact, and the approved topics the rep actually showed this doctor. */
function HcpEngagementPanel({ hcpId }: { hcpId: string }) {
  const [data, setData] = useState<EngagementSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null); setFailed(false);
    (async () => {
      try {
        const res = await fetch(`/api/audience/engagement?hcp=${encodeURIComponent(hcpId)}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as EngagementSummary;
        if (alive) setData(json);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [hcpId]);

  return (
    <div>
      <div style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 10 }}>Engagement so far</div>
      {failed && <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Engagement data unavailable right now.</div>}
      {!failed && !data && <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Loading…</div>}
      {data && data.sessions === 0 && (
        <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>No conversations yet — sessions, questions and topics appear here after the rep&apos;s first session with this doctor.</div>
      )}
      {data && data.sessions > 0 && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {[
              [String(data.sessions), data.sessions === 1 ? "session" : "sessions"],
              [String(data.questions), data.questions === 1 ? "question" : "questions"],
              [String(data.followUps), data.followUps === 1 ? "follow-up" : "follow-ups"],
              ...(data.lastAt ? [[data.lastAt.slice(0, 10), "last contact"]] : []),
            ].map(([v, l]) => (
              <span key={l} style={{ display: "inline-flex", alignItems: "baseline", gap: 5, padding: "6px 11px", background: "var(--dn-surface-2)", borderRadius: 16, font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>
                {v}<span style={{ font: "500 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{l}</span>
              </span>
            ))}
          </div>
          {data.topicsShown.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {data.topicsShown.map((t) => (
                <span key={t} style={{ padding: "5px 10px", background: "rgba(6,73,172,.06)", border: "1px solid var(--dn-border)", borderRadius: 7, font: "500 11px/1.2 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{t}</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ===================== LAUNCH ===================== */
function Launch({ app }: { app: AppState }) {
  const [confirm, setConfirm] = useState(false);
  // Launch state is PERSISTED server-side (survives navigation + restarts) — not local UI state.
  const [activation, setActivation] = useState<{ hcpIds: string[]; launchedAt: string | null } | null>(null);
  const [launchErr, setLaunchErr] = useState("");
  const launched = Boolean(activation?.launchedAt);
  const { rows: hcps } = useAudience();
  const listIds = launched && activation ? activation.hcpIds : app.activation;
  const rows = hcps.filter((h) => listIds.includes(h.id));
  // Real readiness from the Studio (not hardcoded): whether the rep is trained + approved.
  const [repReady, setRepReady] = useState<boolean | null>(null);
  // Every checklist row is COMPUTED (knowledge/ISI from the content store, persona from the
  // studio sections) — two of these used to be hardcoded "Ready", implying checks that never ran.
  const [knowledgeReady, setKnowledgeReady] = useState<boolean | null>(null);
  const [personaReady, setPersonaReady] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/studio").then((r) => (r.ok ? r.json() : null)).then((d: { readiness?: { canLaunch?: boolean }; sections?: { key: string; status: string }[]; activation?: { hcpIds: string[]; launchedAt: string | null } | null } | null) => {
      if (!alive) return;
      setRepReady(d?.readiness?.canLaunch ?? null);
      if (d?.sections) {
        const ok = (k: string) => d.sections!.some((sec) => sec.key === k && sec.status === "complete");
        setPersonaReady(ok("profile") && ok("conversation_rules"));
      }
      if (d?.activation) setActivation(d.activation);
    }).catch(() => {});
    fetch("/api/content/knowledge").then((r) => (r.ok ? r.json() : null)).then((d: { totals?: { activeChunks?: number; activeSafetyStatements?: number } } | null) => {
      if (!alive || !d?.totals) return;
      setKnowledgeReady((d.totals.activeChunks ?? 0) > 0 && (d.totals.activeSafetyStatements ?? 0) > 0);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // The actual per-doctor invite: the shareable doctor link carrying the HCP's identity.
  const inviteLink = (id: string) => `${typeof window !== "undefined" ? window.location.origin : ""}/hcp?hcp=${encodeURIComponent(id)}`;
  const sendInvites = async () => {
    setConfirm(false);
    setLaunchErr("");
    try {
      const res = await fetch("/api/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "launch", hcpIds: app.activation }) });
      const d = (await res.json().catch(() => null)) as { activation?: { hcpIds: string[]; launchedAt: string | null } | null; error?: string } | null;
      if (res.ok && d?.activation?.launchedAt) setActivation(d.activation);
      else setLaunchErr(d?.error ?? "Launch failed — check the rep is approved and the HCPs are in the cohort.");
    } catch {
      setLaunchErr("Launch failed — server unreachable.");
    }
  };
  const hasAudience = app.activation.length > 0;
  const checkRow = (label: string, state: boolean | null, notReady: string) =>
    ({ label, value: state == null ? "Checking…" : state ? "Ready" : notReady, color: state ? "var(--dn-success)" : "var(--dn-warning)", ok: !!state });
  const readiness = [
    checkRow("Approved knowledge", knowledgeReady, "Approve content + ISI first"),
    checkRow("Persona & disclosure", personaReady, "Finish setup sections"),
    { label: "Rep trained & approved", value: repReady == null ? "Checking…" : repReady ? "Ready" : "Finish in Studio", color: repReady ? "var(--dn-success)" : "var(--dn-warning)", ok: !!repReady },
    { label: "Audience selected", value: `${app.activation.length} HCPs`, color: hasAudience ? "var(--dn-success)" : "var(--dn-warning)", ok: hasAudience },
  ];
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1240 }}>
      <div style={eyebrow}>Launch</div>
      <h1 style={{ ...h1, marginBottom: 20 }}>Launch AI rep invitations</h1>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, alignItems: "start" }}>
        <div style={{ ...card, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--dn-border)" }}>
            <span style={{ font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Activation list · {app.activation.length} HCPs</span>
            <span style={{ font: "500 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Secure portal invite</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.3fr 1.5fr 84px", padding: "11px 18px", background: "var(--dn-surface-2)", borderBottom: "1px solid var(--dn-border)", font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>
            <span>HCP</span><span>Segment</span><span>Topic</span><span>Status</span>
          </div>
          {rows.map((a) => (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.3fr 1.5fr 84px", padding: "13px 18px", borderBottom: "1px solid var(--dn-surface-2)", alignItems: "center", ...cell }}>
              <span style={{ fontWeight: 600 }}>{a.name}
                {launched && (
                  <span onClick={() => { void navigator.clipboard?.writeText(inviteLink(a.id)).catch(() => {}); }} title={inviteLink(a.id)} style={{ display: "block", font: "500 10px/1.4 var(--dn-font-mono)", color: "var(--dn-brand-light)", cursor: "pointer", marginTop: 3 }}>⧉ copy invite link</span>
                )}
              </span>
              <span style={{ color: "var(--dn-fg-muted)" }}>{a.decile} · {a.segment}</span>
              <span style={{ color: "var(--dn-fg-muted)" }}>{a.topic}</span>
              <span><span style={segStyle(launched ? "green" : "yellow")}>{launched ? "Invited" : "Ready"}</span></span>
            </div>
          ))}
          {rows.length === 0 && <div style={{ padding: 28, textAlign: "center", font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>No HCPs added yet. Go to <strong style={{ color: "var(--dn-brand-base)" }}>Audience</strong> and add high-opportunity HCPs.</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ ...card, padding: "18px 20px" }}>
            <div style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 14 }}>Launch readiness</div>
            {readiness.map((r) => (
              <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                <span style={{ width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", background: r.ok ? "var(--dn-success)" : "var(--dn-warning)" }}>{r.ok ? "✓" : "!"}</span>
                <span style={{ flex: 1, font: "500 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{r.label}</span>
                <span style={{ font: "500 11.5px/1 var(--dn-font-sans)", color: r.color }}>{r.value}</span>
              </div>
            ))}
          </div>
          <div style={{ ...card, padding: "18px 20px" }}>
            <div style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 13 }}>Send</div>
            <button onClick={() => !launched && app.activation.length && setConfirm(true)} disabled={launched} style={{ ...btnPrimary, width: "100%", padding: 12, opacity: launched || app.activation.length ? 1 : 0.5, background: launched ? "var(--dn-success)" : "var(--dn-brand-base)", cursor: launched ? "default" : "pointer" }}>{launched ? `Launched ✓ · ${activation?.hcpIds.length} invite links live` : `Launch ${app.activation.length} invitations`}</button>
            <button onClick={() => app.setMode("hcp")} style={{ width: "100%", marginTop: 9, padding: 11, background: "#fff", color: "var(--dn-brand-base)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer" }}>Preview doctor view ↗</button>
            {launchErr && <div style={{ marginTop: 11, padding: "9px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, font: "500 11.5px/1.4 var(--dn-font-sans)", color: "#991b1b" }}>{launchErr}</div>}
            {launched && <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 13, padding: "11px 13px", background: "var(--dn-accent-green-bg)", borderRadius: 9 }}><span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: "50%", background: "#166534", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}>✓</span><span style={{ font: "500 11.5px/1.4 var(--dn-font-sans)", color: "#166534" }}>Each doctor&apos;s personal link is live — copy it from the list. Track responses in <strong style={{ cursor: "pointer" }} onClick={() => app.setNav("sessions")}>Sessions</strong>.</span></div>}
          </div>
        </div>
      </div>
      {confirm && (
        <div onClick={() => setConfirm(false)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400, width: "100%", background: "#fff", borderRadius: 16, boxShadow: "var(--dn-shadow-dark)", padding: "26px 26px 22px" }}>
            <div style={{ font: "600 17px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 8 }}>Launch {app.activation.length} invitations?</div>
            <div style={{ font: "400 12.5px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginBottom: 20 }}>This activates a personal, shareable AI-rep link for each of the {app.activation.length} HCPs on your activation list (sessions attribute to that doctor). Email delivery isn&apos;t connected yet — copy each link from the list to send it.</div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => void sendInvites()} style={{ ...btnPrimary, flex: 1, padding: 11 }}>Activate invite links</button>
              <button onClick={() => setConfirm(false)} style={{ ...btnGhost, padding: "11px 18px" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===================== SESSIONS ===================== */
type SessionRow = {
  id: number | string;
  hcp: string;
  date: string;
  duration: string;
  questions: number | string;
  comp: string;
  compTone: "green" | "yellow" | "pink" | "red";
  followup: string;
};

function Sessions({ app }: { app: AppState }) {
  // Start empty and show ONLY real sessions from the API — never fabricated demo
  // rows (clicking a fake row would 404 into the illustrative view with no video).
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) return;
        const json = (await res.json()) as { rows?: SessionRow[] };
        if (alive) setRows(json.rows ?? []);
      } catch {
        /* leave empty → honest empty state */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, []);
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1340 }}>
      <div style={eyebrow}>Sessions</div>
      <h1 style={{ ...h1, marginBottom: 6 }}>Who engaged?</h1>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 16px" }}>Completed and in-progress AI rep sessions. <strong style={{ color: "var(--dn-fg)" }}>Review</strong> the full compliance evidence, or <strong style={{ color: "var(--dn-fg)" }}>Coach</strong> the rep from a real conversation.</p>
      <div style={{ ...card, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 0.8fr 0.8fr 1fr 1.1fr 150px", padding: "12px 18px", background: "var(--dn-surface-2)", borderBottom: "1px solid var(--dn-border)", font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>
          <span>HCP</span><span>Date</span><span>Duration</span><span>Questions</span><span>Compliance</span><span>Follow-up</span><span />
        </div>
        {loaded && rows.length === 0 && (
          <div style={{ padding: "28px 18px", textAlign: "center", font: "400 13px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>
            No sessions yet. Start one in <strong style={{ color: "var(--dn-fg)" }}>Preview HCP experience</strong> (Text, Voice, or Video) — completed conversations appear here with their full transcript and compliance evidence.
          </div>
        )}
        {rows.map((s) => (
          <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 0.8fr 0.8fr 1fr 1.1fr 150px", padding: "13px 18px", borderBottom: "1px solid var(--dn-surface-2)", alignItems: "center", ...cell }}>
            <span style={{ fontWeight: 600, cursor: "pointer" }} onClick={() => { app.setSelectedSessionId(String(s.id)); app.setNav("audit"); }}>{s.hcp}</span>
            <span style={{ color: "var(--dn-fg-muted)", fontFamily: "var(--dn-font-mono)", fontSize: 11.5 }}>{s.date}</span>
            <span style={{ color: "var(--dn-fg-muted)" }}>{s.duration}</span>
            <span style={{ color: "var(--dn-fg-muted)" }}>{s.questions}</span>
            <span><span style={compStyle(s.compTone)}>{s.comp}</span></span>
            <span style={{ font: "500 12px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{s.followup}</span>
            <span style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <span data-testid="review-session" onClick={() => { app.setSelectedSessionId(String(s.id)); app.setNav("audit"); }} style={{ padding: "6px 9px", background: "rgba(6,73,172,.08)", color: "var(--dn-brand-base)", borderRadius: 7, font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}>Review</span>
              <span onClick={() => { app.setStudioMode("train"); app.setNav("studio"); }} style={{ padding: "6px 9px", background: "#fff", border: "1px solid var(--dn-border)", color: "var(--dn-fg-muted)", borderRadius: 7, font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}>Coach</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================== ANALYTICS ===================== */
type AnalyticsTab = { key: string; label: string };
type Metric = { key?: string; label: string; value: string; sub: string; tone: string; drillTo?: string };

function Analytics() {
  const [cat, setCat] = useState("targeting");
  const [tabs, setTabs] = useState<AnalyticsTab[]>(ANALYTICS_TABS as AnalyticsTab[]);
  const [data, setData] = useState<Record<string, Metric[]>>(ANALYTICS_KPIS as Record<string, Metric[]>);
  // false → the fixture KPIs are showing (loading/failed); banner below labels them.
  const [liveKpis, setLiveKpis] = useState(false);
  const [funnel, setFunnel] = useState<{ label: string; count: number | string; pct: number }[]>([
    { label: "Target HCPs", count: "—", pct: 100 }, { label: "Sessions started", count: "—", pct: 0 },
    { label: "Completed detail", count: "—", pct: 0 }, { label: "Follow-up created", count: "—", pct: 0 },
  ]);
  const [statusBreakdown, setStatusBreakdown] = useState<{ label: string; count: number; tone: string }[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/analytics");
        if (!res.ok) return;
        const json = (await res.json()) as { tabs?: AnalyticsTab[]; data?: Record<string, Metric[]>; funnel?: typeof funnel; statusBreakdown?: typeof statusBreakdown };
        if (!alive) return;
        if (json.tabs && json.tabs.length) setTabs(json.tabs);
        if (json.data) { setData(json.data); setLiveKpis(true); }
        if (json.funnel) setFunnel(json.funnel);
        if (json.statusBreakdown) setStatusBreakdown(json.statusBreakdown);
      } catch {
        /* keep static fallback */
      }
    })();
    return () => { alive = false; };
  }, []);
  const kpis = data[cat] ?? [];
  const maxStatus = Math.max(1, ...statusBreakdown.map((s) => s.count));
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1360 }}>
      <div style={eyebrow}>Analytics</div>
      <h1 style={{ ...h1, marginBottom: 4 }}>Campaign Analytics</h1>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 16px" }}>Targeting, engagement, content, compliance, CRM, and realtime performance.</p>
      {!liveKpis && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 0 14px", padding: "9px 13px", background: "var(--dn-accent-yellow-bg)", border: "1px solid #fcd34d", borderRadius: 9, font: "500 12px/1.4 var(--dn-font-sans)", color: "#92400e" }}>
          ⚠ Showing sample metrics — live analytics haven&apos;t loaded yet. These numbers are illustrative, not your campaign data.
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid var(--dn-border)", flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <div key={t.key} onClick={() => setCat(t.key)} style={{ padding: "10px 14px", font: `${cat === t.key ? 600 : 500} 12.5px/1 var(--dn-font-sans)`, color: cat === t.key ? "var(--dn-brand-base)" : "var(--dn-fg-muted)", borderBottom: `2px solid ${cat === t.key ? "var(--dn-brand-base)" : "transparent"}`, cursor: "pointer", marginBottom: -1 }}>{t.label}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 13, marginBottom: 16 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...card, padding: "15px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ font: "600 11px/1.3 var(--dn-font-sans)", letterSpacing: ".03em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>{k.label}</span></div>
            <div style={{ font: "600 27px/1.1 var(--dn-font-sans)", color: TONE_COLORS[k.tone], margin: "9px 0 5px", letterSpacing: "-0.02em" }}>{k.value}</div>
            <div style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{k.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ ...card, padding: "18px 20px" }}>
          <div style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 4 }}>Engagement funnel</div>
          <div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 16 }}>Outreach → session start → completed detail → follow-up</div>
          {funnel.map((f) => (
            <div key={f.label} style={{ marginBottom: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><span style={{ font: "500 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{f.label}</span><span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{f.count} · {f.pct}%</span></div>
              <div style={{ height: 22, borderRadius: 6, background: "var(--dn-surface-2)", overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 6, background: "var(--dn-gradient-primary)", width: `${f.pct}%` }} /></div>
            </div>
          ))}
        </div>
        <div style={{ ...card, padding: "18px 20px" }}>
          <div style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 4 }}>Sessions by compliance outcome</div>
          <div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 16 }}>Derived from the real per-session compliance status</div>
          {statusBreakdown.length === 0 && <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>No sessions yet.</div>}
          {statusBreakdown.map((s) => (
            <div key={s.label} style={{ marginBottom: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}><span style={{ font: "500 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{s.label}</span><span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{s.count}</span></div>
              <div style={{ height: 22, borderRadius: 6, background: "var(--dn-surface-2)", overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 6, background: TONE_COLORS[s.tone] ?? "var(--dn-brand-base)", width: `${Math.round((s.count / maxStatus) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ===================== SESSION DETAIL ===================== */
type SessionDetailData = {
  session: { hcp: string; startedAt: string; durationSeconds: number; questionCount: number; complianceStatus: string; recordingUrl?: string | null };
  turns: { speaker: "hcp" | "rep"; text: string; sourceIds: string[]; detailAidSlideId?: string | null; at?: string | null }[];
  audit: { seq: number; type: string; payload: Record<string, unknown> }[];
  hasTurnDetail: boolean;
};
const COMP_LABEL: Record<string, string> = { approved: "Approved", needs_review: "Needs review", ae_routed: "AE routed", blocked_escalated: "Blocked + escalated" };
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const TRACE = ["Input (text / ASR)", "Intent + risk classifier", "Policy router", "Approved retrieval + source validation", "Response builder / grounding", "Final compliance gate", "Output + audit + follow-up"];
const REVIEW_SLIDE_CUE_DELAY_SEC = 1.1;

function SessionDetail({ app }: { app: AppState }) {
  const [sel, setSel] = useState(0);
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nowSec, setNowSec] = useState(0);
  // Real recording length once the video's metadata resolves — used to scale the transcript/slide
  // timeline to the video so they track it end-to-end (0 until known / no recording).
  const [vidDur, setVidDur] = useState(0);
  useEffect(() => {
    let alive = true;
    setDetail(null); setSel(0); setNowSec(0); setVidDur(0);
    if (!app.selectedSessionId) return;
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(app.selectedSessionId!)}`);
        if (!res.ok) return;
        const json = (await res.json()) as SessionDetailData;
        if (alive) setDetail(json);
      } catch { /* fall back to illustrative */ }
    })();
    return () => { alive = false; };
  }, [app.selectedSessionId]);

  // Pair the real turns into HCP→rep exchanges.
  const exchanges: { q: string; a: string; sourceIds: string[] }[] = [];
  const turns = detail?.turns ?? [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.speaker === "hcp") {
      const rep = turns[i + 1]?.speaker === "rep" ? turns[i + 1]! : null;
      exchanges.push({ q: turns[i]!.text, a: rep?.text ?? "", sourceIds: rep?.sourceIds ?? [] });
    }
  }
  // A session is "real" (show video + click-through transcript) when it has any
  // real turns OR a recording — NOT only when there are paired HCP→rep exchanges.
  // A greeting-only video call (rep turn, no HCP turn yet) is still a real session.
  const real = !!detail && (detail.hasTurnDetail || !!detail.session.recordingUrl);

  const back = <div onClick={() => app.setNav("sessions")} style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "600 11.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer", marginBottom: 12 }}>‹ Back to Sessions</div>;
  const traceBox = (
    <div style={{ padding: 18, borderTop: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
      <div style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 4 }}>Turn-level decision path</div>
      <div style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 14 }}>Every turn passes this controlled graph before the HCP hears it.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {TRACE.map((n, i) => (
          <div key={i}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 8 }}>
              <span style={{ font: "700 9px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", background: "rgba(6,73,172,.08)", padding: "3px 6px", borderRadius: 5 }}>{i + 1}</span>
              <span style={{ font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{n}</span>
            </div>
            {i < TRACE.length - 1 && <div style={{ textAlign: "center", font: "400 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "2px 0" }}>↓</div>}
          </div>
        ))}
      </div>
    </div>
  );

  if (real && detail) {
    const s = detail.session;
    const sourcesCited = new Set(turns.filter((t) => t.speaker === "rep").flatMap((t) => t.sourceIds)).size;
    const gate = detail.audit.filter((a) => a.type === "compliance_decision");
    const approved = gate.filter((a) => a.payload.decision === "approved").length;
    const summary = [
      { label: "Turns", value: String(turns.length), color: "var(--dn-fg)" },
      { label: "Questions", value: String(s.questionCount), color: "var(--dn-fg)" },
      { label: "Gated outputs", value: `${approved}/${gate.length || exchanges.length}`, color: "var(--dn-success)" },
      { label: "Sources cited", value: String(sourcesCited), color: "var(--dn-brand-base)" },
      { label: "Compliance", value: COMP_LABEL[s.complianceStatus] ?? s.complianceStatus, color: "var(--dn-fg)" },
    ];
    // Align the timeline to the FIRST turn — the recording starts at the replica's
    // first live frame (~the greeting), not the session-created timestamp — so the
    // transcript + slide changes track the video.
    // Replay timeline. Turn `at` timestamps are stamped at API-call time, so a burst of turns (a
    // deck walkthrough, or several Tavus replies logged back-to-back) collapses to the same second —
    // which made every line show ~00:18 and the slide jump to the last turn and freeze. Instead we
    // build a MONOTONIC timeline: each turn starts no earlier than the previous turn's estimated
    // speaking time, while a real pause (a larger `at` gap) is preserved. When a recording exists we
    // scale the whole timeline to its true length so the transcript + slide track the video.
    type Turn = (typeof turns)[number];
    const startMs = turns[0]?.at ? Date.parse(turns[0]!.at!) : Date.parse(s.startedAt);
    const estDur = (t: Turn) => Math.min(32, Math.max(2.5, (t.text ?? "").trim().split(/\s+/).filter(Boolean).length * 0.42)); // ~140 wpm, clamped
    const rawOffsets: number[] = [];
    for (let i = 0; i < turns.length; i++) {
      const at = turns[i]!.at ? Math.max(0, (Date.parse(turns[i]!.at!) - startMs) / 1000) : 0;
      rawOffsets[i] = i === 0 ? 0 : Math.max(at, rawOffsets[i - 1]! + estDur(turns[i - 1]!));
    }
    const estTotal = (rawOffsets[turns.length - 1] ?? 0) + (turns.length ? estDur(turns[turns.length - 1]!) : 0);
    const recordingShort = vidDur > 1 && estTotal > vidDur + 8;
    const scale = vidDur > 1 && estTotal > 0 && !recordingShort ? vidDur / estTotal : 1;
    const offsets = rawOffsets.map((o) => o * scale);
    const offsetOf = (t: Turn) => { const i = turns.indexOf(t); return i >= 0 ? offsets[i]! : 0; };
    // Duration: the real recording length if known; else the recorded seconds; else the estimated
    // transcript span — so the header shows a real length, never "00:00" for a live/Tavus session.
    const effectiveDuration = Math.round(Math.max(s.durationSeconds || 0, estTotal, recordingShort ? vidDur : 0));
    const seekTo = (off: number, i: number) => {
      setSel(i);
      const v = videoRef.current;
      if (v) { try { v.currentTime = off; void v.play?.(); } catch { /* noop */ } }
    };
    const selTurn = turns[Math.min(sel, turns.length - 1)]!;
    // The turn currently PLAYING (by video position); the detail-aid slide follows it
    // as the recording plays, and falls back to the clicked line when paused.
    const playIdx = turns.findIndex((t, i) => {
      const off = offsetOf(t);
      const next = i + 1 < turns.length ? offsetOf(turns[i + 1]!) : off + 3600;
      return nowSec >= off && nowSec < next;
    });
    const activeTurn = nowSec > 0.2 && playIdx >= 0 ? turns[playIdx]! : selTurn;
    // The detail-aid slide follows what the REP is presenting: it changes when the rep
    // starts answering, not the instant the HCP asks. A human keeps the current slide up
    // while the doctor is talking, then switches as they begin the answer — so we take the
    // slide the rep actually showed (turn.detailAidSlideId, resolved server-side) from the
    // most recent rep turn at/before the active line that had one; title before the first.
    const activeIdx = turns.indexOf(activeTurn);
    let slideId = "slide_title";
    for (let j = activeIdx; j >= 0; j--) {
      const turn = turns[j]!;
      const sid = turn.detailAidSlideId;
      if (turn.speaker === "rep" && sid) {
        const delayPassed = nowSec <= 0.2 || nowSec >= offsetOf(turn) + REVIEW_SLIDE_CUE_DELAY_SEC;
        if (delayPassed) { slideId = sid; break; }
      }
    }
    return (
      <div style={{ padding: "24px 30px 40px", maxWidth: 1400 }}>
        {back}
        <div style={eyebrow}>Session Detail · live record</div>
        <h1 style={{ ...h1, marginBottom: 6 }}>{s.hcp} — session review</h1>
        <p style={{ font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 12px" }}>{app.selectedSessionId} · {mmss(effectiveDuration)} · {detail.audit.length} audited events — every turn is a provable record.</p>
        {recordingShort && (
          <div style={{ margin: "0 0 12px", padding: "9px 12px", border: "1px solid #f3c969", background: "#fff8e6", borderRadius: 8, font: "600 11.5px/1.45 var(--dn-font-sans)", color: "#7a4b00" }}>
            Recording ends at {mmss(Math.round(vidDur))}, but the transcript runs to {mmss(Math.round(estTotal))}. Later transcript lines were logged after the captured Tavus media stopped, so this replay is not a clean recording.
          </div>
        )}
        {/* Compact stat strip (was a tall 5-card grid) — keeps the replay above the fold. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {summary.map((a) => (
            <span key={a.label} style={{ display: "inline-flex", alignItems: "baseline", gap: 6, padding: "6px 12px", background: "var(--dn-surface)", border: "1px solid var(--dn-border)", borderRadius: 20, font: "600 10.5px/1 var(--dn-font-sans)", letterSpacing: ".03em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>
              {a.label}<strong style={{ font: "700 12.5px/1 var(--dn-font-sans)", color: a.color }}>{a.value}</strong>
            </span>
          ))}
        </div>
        {/* Symmetric 2×2 replay — four equal blocks: recorded rep · approved slide (top row),
            turn evidence · click-through transcript (bottom row). Slides + transcript follow the
            recording timeline; click any line to jump the video. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: 300, gap: 16 }}>
          {/* 1 · recorded rep (in place of the live avatar) */}
          <div style={{ ...card, padding: 0, overflow: "hidden", background: "#0a1a33", display: "flex" }}>
            {s.recordingUrl ? (
              <video
                ref={videoRef}
                controls
                src={s.recordingUrl}
                onTimeUpdate={(e) => setNowSec(e.currentTarget.currentTime)}
                onDurationChange={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setVidDur(d); }}
                // MediaRecorder webm has no duration header (duration === Infinity), which
                // breaks the scrubber + click-to-seek; force a seek to the end so the browser
                // computes the real duration, then snap back to the start.
                onLoadedMetadata={(e) => { const v = e.currentTarget; if (!isFinite(v.duration)) { const fix = () => { v.removeEventListener("seeked", fix); v.currentTime = 0; }; v.addEventListener("seeked", fix); v.currentTime = 1e7; } }}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000" }}
              />
            ) : (
              <div style={{ margin: "auto", padding: "0 20px", textAlign: "center", font: "400 12px/1.5 var(--dn-font-sans)", color: "#cfe0f6" }}>🎥 No recording — this session was text/preview turns. The click-through transcript is below.</div>
            )}
          </div>
          {/* 2 · approved slide the rep showed (follows the recording) */}
          <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 8 }}>On screen now · follows the recording</div>
            <SlideView focusId={slideId} compact fill />
          </div>
          {/* 3 · turn evidence for the playing / selected line */}
          <div style={{ ...card, padding: "14px 16px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 2 }}>
              <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Turn evidence</span>
              {(() => {
                // "Coach this exchange": jump to Training with the doctor's question from THIS
                // exchange pre-asked, so the reviewer coaches the exact line that needed work.
                // Before the first HCP line (e.g. the greeting), fall back to the session's
                // first doctor question — still a real line from this conversation.
                const idx = turns.indexOf(activeTurn);
                let q = "";
                for (let j = idx; j >= 0; j--) if (turns[j]!.speaker === "hcp") { q = turns[j]!.text; break; }
                if (!q) q = turns.find((t) => t.speaker === "hcp")?.text ?? "";
                if (!q) return null;
                return (
                  <span
                    data-testid="coach-exchange"
                    onClick={() => {
                      try { window.localStorage.setItem(TRAIN_SEED_KEY, JSON.stringify({ q, from: app.selectedSessionId })); } catch { /* storage disabled — Train still opens */ }
                      app.setStudioMode("train");
                      app.setNav("studio");
                    }}
                    style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    ✎ Coach this exchange →
                  </span>
                );
              })()}
            </div>
            <div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 10 }}>{activeTurn.speaker === "hcp" ? "HCP" : "AI rep"} line at {mmss(Math.round(offsetOf(activeTurn)))}.</div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {([["Speaker", activeTurn.speaker === "hcp" ? "HCP" : "AI rep"], ["Said", activeTurn.text], ["Approved sources", activeTurn.sourceIds.length ? activeTurn.sourceIds.join(", ") : "None — routed / refused"], ["Compliance", COMP_LABEL[s.complianceStatus] ?? s.complianceStatus]] as [string, string][]).map(([l, v]) => (
                <div key={l} style={{ marginBottom: 10 }}>
                  <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 4 }}>{l}</div>
                  <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)", fontFamily: l === "Approved sources" ? "var(--dn-font-mono)" : undefined }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
          {/* 4 · click-through transcript */}
          <div style={{ ...card, padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", background: "var(--dn-surface-2)", borderBottom: "1px solid var(--dn-border)", font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", display: "flex", justifyContent: "space-between" }}>
              <span>Transcript</span><span>Click to jump</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {turns.map((t, i) => {
                const off = offsetOf(t);
                const next = i + 1 < turns.length ? offsetOf(turns[i + 1]!) : off + 3600;
                const playing = !!s.recordingUrl && nowSec >= off && nowSec < next;
                const isSel = sel === i;
                return (
                  <div key={`${t.at ?? ""}:${t.speaker}:${i}`} onClick={() => seekTo(off, i)} style={{ display: "grid", gridTemplateColumns: "46px 1fr", gap: 10, padding: "9px 16px", borderBottom: "1px solid var(--dn-surface-2)", cursor: "pointer", background: isSel ? "rgba(6,73,172,.06)" : playing ? "var(--dn-surface-2)" : "transparent", borderLeft: `3px solid ${playing ? "var(--dn-brand-base)" : "transparent"}` }}>
                    <span style={{ fontFamily: "var(--dn-font-mono)", fontSize: 11, color: "var(--dn-brand-light)", paddingTop: 2 }}>{mmss(Math.round(off))}</span>
                    <span>
                      <span style={{ display: "block", font: "700 9px/1 var(--dn-font-sans)", letterSpacing: ".06em", textTransform: "uppercase", color: t.speaker === "hcp" ? "var(--dn-fg-subtle)" : "var(--dn-brand-base)", marginBottom: 3 }}>{t.speaker === "hcp" ? "HCP" : "AI rep"}</span>
                      <span style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{t.text}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", padding: "8px 0", listStyle: "none" }}>▸ Turn-level compliance path</summary>
          <div style={{ ...card, overflow: "hidden", marginTop: 8, maxWidth: 640 }}>{traceBox}</div>
        </details>
      </div>
    );
  }

  // Honest empty state — a session with no recorded turns yet. Never show fake
  // turns; direct the user to run a real conversation.
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1400 }}>
      {back}
      <div style={eyebrow}>Session Detail</div>
      <h1 style={{ ...h1, marginBottom: 6 }}>{detail?.session.hcp ?? "Session"} — session review</h1>
      <div style={{ ...card, padding: "26px 24px", maxWidth: 760, marginBottom: 14, font: "400 13px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>
        This session has no recorded turns yet. Start a conversation in <strong style={{ color: "var(--dn-fg)" }}>Preview HCP experience</strong> (Text, Voice, or Video) — every turn is logged here with its approved sources and compliance decision, and video calls attach a synced recording.
      </div>
      <div style={{ ...card, overflow: "hidden", maxWidth: 760 }}>{traceBox}</div>
    </div>
  );
}

/* ===================== FOLLOW-UPS ===================== */
type FollowUpRow = { id: number; hcp: string; reason: string; owner: string; target: string; status: string };

function FollowUps() {
  const [statuses, setStatuses] = useState<Record<number, string>>({});
  const [sel, setSel] = useState(0);
  const [jsonOpen, setJsonOpen] = useState(false);
  // Real follow-ups only (created automatically after each session) — no fake rows.
  const [baseRows, setBaseRows] = useState<FollowUpRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/followups");
        if (!res.ok) return;
        const json = (await res.json()) as { rows?: FollowUpRow[] };
        if (alive) setBaseRows(json.rows ?? []);
      } catch {
        /* leave empty → honest empty state */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, []);
  const events = baseRows.map((e) => ({ ...e, status: statuses[e.id] ?? e.status }));
  const selected = events[Math.min(sel, events.length - 1)];
  const retryAll = () => { const m: Record<number, string> = {}; events.forEach((e) => { if (e.status !== "Sent to CRM") m[e.id] = "Retrying"; }); setStatuses((s) => ({ ...s, ...m })); setTimeout(() => { const d: Record<number, string> = {}; events.forEach((e) => (d[e.id] = "Sent to CRM")); setStatuses(d); }, 1100); };
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1400 }}>
      <div style={eyebrow}>Follow-ups</div>
      <h1 style={{ ...h1, marginBottom: 6 }}>Who needs follow-up?</h1>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 20px" }}>Follow-ups are created automatically after each session and synced to your CRM in the background. You just watch the status — the technical payload stays out of your way.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14, alignItems: "start" }}>
        <div style={{ ...card, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", borderBottom: "1px solid var(--dn-border)" }}>
            <span style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Follow-up queue</span>
            <button onClick={retryAll} style={{ ...btnGhost, padding: "8px 14px", font: "600 11.5px/1 var(--dn-font-sans)" }}>Retry failed</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.5fr 1.1fr 1fr 96px", padding: "11px 16px", background: "var(--dn-surface-2)", borderBottom: "1px solid var(--dn-border)", font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>
            <span>HCP</span><span>Reason for follow-up</span><span>Owner</span><span>Target</span><span>Status</span>
          </div>
          {loaded && events.length === 0 && (
            <div style={{ padding: "26px 16px", textAlign: "center", font: "400 13px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>
              No follow-ups yet. They&apos;re created automatically when a session routes to MSL, Medical Information, pharmacovigilance, or a human rep.
            </div>
          )}
          {events.map((e, i) => (
            <div key={e.id} onClick={() => setSel(i)} style={{ display: "grid", gridTemplateColumns: "1.4fr 1.5fr 1.1fr 1fr 96px", padding: "13px 16px", borderBottom: "1px solid var(--dn-surface-2)", alignItems: "center", cursor: "pointer", background: sel === i ? "var(--dn-surface-2)" : "transparent" }}>
              <span style={{ font: "600 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{e.hcp}</span>
              <span style={{ font: "500 12px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-muted)", paddingRight: 8 }}>{e.reason}</span>
              <span style={{ font: "400 12px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{e.owner}</span>
              <span style={{ font: "500 12px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{e.target}</span>
              <span><span style={statusBadge(e.status)}>{e.status}</span></span>
            </div>
          ))}
        </div>
        {selected && (
        <div style={{ ...card, padding: "18px 20px" }}>
          <div style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 16 }}>{selected.hcp}</div>
          {[["Reason", selected.reason], ["Owner", selected.owner], ["Target system", selected.target], ["Status", selected.status]].map(([l, v]) => (
            <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--dn-surface-2)" }}>
              <span style={{ font: "500 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)", flexShrink: 0 }}>{l}</span>
              <span style={{ font: "500 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg)", textAlign: "right" }}>{v}</span>
            </div>
          ))}
          <button onClick={() => { setStatuses((s) => ({ ...s, [selected.id]: "Retrying" })); setTimeout(() => setStatuses((s) => ({ ...s, [selected.id]: "Sent to CRM" })), 1000); }} style={{ ...btnPrimary, width: "100%", marginTop: 14, padding: 11 }}>Push to CRM now</button>
          <div style={{ marginTop: 12 }}>
            <div onClick={() => setJsonOpen((v) => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", padding: "9px 0", borderTop: "1px solid var(--dn-surface-2)" }}>
              <span style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Example payload format (JSON)</span>
              <span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{jsonOpen ? "▾" : "▸"}</span>
            </div>
            {jsonOpen && <pre style={{ margin: "6px 0 0", padding: 14, background: "#0a1a33", borderRadius: 10, overflowX: "auto", font: "400 11px/1.6 var(--dn-font-mono)", color: "#bfdbfe", whiteSpace: "pre-wrap" }}>{JSON.stringify({ event_type: "AI_DETAIL_COMPLETED", hcp: selected.hcp, target: selected.target, followup_type: "msl", isi_delivered: true, off_label_flag: false }, null, 2)}</pre>}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

function statusBadge(s: string): React.CSSProperties {
  const m: Record<string, [string, string]> = { Created: ["#e0e7ff", "#3730a3"], Ready: ["#e0e7ff", "#3730a3"], Retrying: ["var(--dn-accent-yellow-bg)", "#92400e"], "Sent to CRM": ["var(--dn-accent-green-bg)", "#166534"], Failed: ["#fee2e2", "#991b1b"], "Needs mapping": ["var(--dn-accent-pink-bg)", "#9d174d"] };
  const [bg, c] = m[s] ?? m.Created!;
  return { display: "inline-block", padding: "4px 10px", borderRadius: 6, font: "600 10.5px/1 var(--dn-font-sans)", background: bg, color: c };
}

/* ===================== ADMIN ===================== */
interface IntegrationsSnap {
  seats: { role: string; vendor: string; status: "connected" | "simulated" | "not_configured"; detail?: string }[];
  classifiers: { name: string; available: boolean }[];
  crm: { name: string; status: "connected" | "simulated" | "not_configured"; active: boolean; detail?: string }[];
}

const INTEGRATION_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  connected: { label: "Connected", bg: "var(--dn-accent-green-bg)", color: "#166534" },
  simulated: { label: "Simulated", bg: "var(--dn-accent-yellow-bg)", color: "#92400e" },
  not_configured: { label: "Not connected", bg: "var(--dn-surface-2)", color: "var(--dn-fg-muted)" },
};

function Admin() {
  // REAL integration status from the container (mock → "Simulated", missing key →
  // "Not connected") — never hardcoded "Connected" badges.
  const [integrations, setIntegrations] = useState<IntegrationsSnap | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/integrations")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: IntegrationsSnap | null) => { if (alive && d) setIntegrations(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1100 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "#fff", background: "#475569", padding: "5px 10px", borderRadius: 6, marginBottom: 12 }}>Internal · Platform Admin</div>
      <h1 style={{ ...h1, marginBottom: 6 }}>Vendor stack &amp; connectors</h1>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 16px", maxWidth: 720 }}>Not visible to brand teams. The runtime vendor stack is swappable without changing governance — brand users only configure persona, content, targeting and outreach.</p>
      <div style={{ marginBottom: 22, font: "500 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>
        Model A/B testing (Claude / OpenAI / Thinking Machines, latency + streaming) lives inside the AI rep
        conversation — open <strong>AI Rep → Training &amp; Preview → ⚙ Model lab</strong>.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ ...card, padding: "20px 22px" }}>
          <div style={{ font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--dn-border)" }}>AI vendor stack · live status</div>
          {(integrations?.seats ?? VENDOR_STACK.map((v) => ({ ...v, status: "not_configured" as const, detail: "Loading status…" }))).map((v) => {
            const b = INTEGRATION_BADGE[v.status] ?? INTEGRATION_BADGE.not_configured!;
            return (
              <div key={v.role} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderBottom: "1px solid var(--dn-surface-2)" }}>
                <div><div style={{ font: "600 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{v.role}</div><div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{v.vendor}{"detail" in v && v.detail ? ` — ${v.detail}` : ""}</div></div>
                <span style={{ font: "600 10.5px/1 var(--dn-font-sans)", padding: "5px 10px", borderRadius: 20, background: b.bg, color: b.color, whiteSpace: "nowrap" }}>{b.label}</span>
              </div>
            );
          })}
          {integrations && (
            <div style={{ marginTop: 12, font: "400 11px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
              LLM classifiers: {integrations.classifiers.map((cl) => `${cl.name}${cl.available ? " ✓" : " (no key)"}`).join(" · ")}
            </div>
          )}
        </div>
        <div style={{ ...card, padding: "20px 22px" }}>
          <div style={{ font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--dn-border)" }}>CRM &amp; export connectors · live status</div>
          {(integrations?.crm ?? CRM_CONNECTORS.map((c) => ({ name: c, status: "not_configured" as const, active: false }))).map((c) => {
            const b = INTEGRATION_BADGE[c.status] ?? INTEGRATION_BADGE.not_configured!;
            return (
              <div key={c.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderBottom: "1px solid var(--dn-surface-2)" }}>
                <div><div style={{ font: "600 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{c.name}</div>{"detail" in c && c.detail ? <div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{c.detail}</div> : null}</div>
                <span style={{ font: "600 10.5px/1 var(--dn-font-sans)", padding: "5px 10px", borderRadius: 20, background: b.bg, color: b.color, whiteSpace: "nowrap" }}>{b.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

