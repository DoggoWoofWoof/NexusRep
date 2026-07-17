"use client";

import { useEffect, useState } from "react";
import { btnGhost, type AppState } from "./NexusRepApp";
import { card, cell, eyebrow, h1 } from "./ui";
import { type Hcp } from "./data";
import { useAudience } from "./useAudience";

export function Audience({ app }: { app: AppState }) {
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
    { label: "Target HCPs", value: apiSummary ? String(apiSummary.cohortSize) : "—", color: "var(--dn-brand-base)", sub: "In the target cohort" },
    { label: "Avg opp score", value: apiSummary ? apiSummary.averageScore.toFixed(1) : "—", color: "var(--dn-fg)", sub: "0–100 · ranked within cohort" },
    { label: "Top-decile targets", value: String(topDecile), color: "var(--dn-fg)", sub: "High-volume prescribers (D1–D2)" },
    { label: "Eligible patients", value: apiSummary ? apiSummary.eligiblePatients.toLocaleString() : "—", color: "var(--dn-fg)", sub: "Target-indication claims · no PHI" },
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
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "8px 0 18px", maxWidth: 820 }}>Ranked by opportunity score from HCP-level aggregate claims signals. Click a row for the full rationale, then add selected HCPs to launch.</p>
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
            {hcps.length === 0
              ? "No target cohort yet — set the product, indication, and specialties in the AI Rep Studio to build your audience."
              : "No doctors match — clear the search or specialty filter."}
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
