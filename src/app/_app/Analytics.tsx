"use client";

import { useEffect, useState } from "react";
import { card, eyebrow, h1 } from "./ui";
import { ANALYTICS_KPIS, ANALYTICS_TABS, TONE_COLORS } from "./data";

type AnalyticsTab = { key: string; label: string };
type Metric = { key?: string; label: string; value: string; sub: string; tone: string; drillTo?: string };

export function Analytics() {
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
