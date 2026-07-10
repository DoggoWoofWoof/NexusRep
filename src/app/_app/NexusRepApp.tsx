"use client";

/**
 * NexusRep — full app, ported from the NexusRep.dc.html prototype into React.
 * Holds brand-console + HCP-experience state and renders the active screen.
 * Inline styles mirror the prototype; the DocNexus design tokens come from
 * /colors_and_type.css. Live behaviour (compliance/A-V) is wired where relevant.
 */

import { useEffect, useState } from "react";
import {
  COMMAND_KPIS,
  TONE_COLORS,
} from "./data";
import { BrandScreens } from "./BrandScreens";
import { StudioScreen } from "./StudioScreen";
import { HcpExperience } from "./HcpExperience";
import { useBrand } from "../_components/useBrand";

export type Screen =
  | "overview"
  | "studio"
  | "targeting"
  | "outreach"
  | "sessions"
  | "analytics"
  | "audit"
  | "crm"
  | "admin";

const NAV_PLAN: { id: Screen; label: string; badge?: string }[] = [
  { id: "studio", label: "AI Rep", badge: "68%" },
  { id: "overview", label: "Overview" },
];
const NAV_GOVERN: { id: Screen; label: string }[] = [
  { id: "targeting", label: "Audience" },
  { id: "outreach", label: "Launch" },
  { id: "sessions", label: "Sessions" },
  { id: "analytics", label: "Analytics" },
  { id: "crm", label: "Follow-ups" },
];

export interface AppState {
  nav: Screen;
  setNav: (s: Screen) => void;
  mode: "brand" | "hcp";
  setMode: (m: "brand" | "hcp") => void;
  activation: string[];
  toggleActivation: (id: string) => void;
  drawerId: string | null;
  setDrawerId: (id: string | null) => void;
  /** Cohort HCP the in-app doctor-view preview should run AS (Audience → "Preview AI rep").
   *  Empty → the demo identity. The shared /hcp link uses ?hcp= instead. */
  sessionHcpId: string;
  setSessionHcpId: (id: string) => void;
  studioMode: string;
  setStudioMode: (m: string) => void;
  /** Session id whose evidence the Session-detail view should load. */
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
}

export function NexusRepApp() {
  const [mode, setMode] = useState<"brand" | "hcp">("brand");
  const [nav, setNavState] = useState<Screen>("overview");
  const [studioMode, setStudioMode] = useState("setup");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [activation, setActivation] = useState<string[]>([]);
  const [sessionHcpId, setSessionHcpId] = useState(""); // no fake default identity
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [attnOpen, setAttnOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const brand = useBrand();
  const attention = useAttention(); // real pending items, not a hardcoded "3"

  const setNav = (s: Screen) => {
    setNavState(s);
    setMode("brand");
    setDrawerId(null);
  };
  const toggleActivation = (id: string) =>
    setActivation((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const app: AppState = {
    nav, setNav, mode, setMode, activation, toggleActivation,
    drawerId, setDrawerId, sessionHcpId, setSessionHcpId, studioMode, setStudioMode,
    selectedSessionId, setSelectedSessionId,
  };

  if (mode === "hcp") {
    return <HcpExperience app={app} />;
  }

  return (
    <div style={{ height: "100vh", overflow: "hidden", display: "flex", background: "var(--dn-bg)", color: "var(--dn-fg)", fontFamily: "var(--dn-font-sans)" }}>
      {/* LEFT NAV RAIL */}
      <aside style={{ width: navCollapsed ? 64 : 236, flexShrink: 0, background: "var(--dn-brand-dark)", color: "#fff", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(255,255,255,.07)", transition: "width .18s ease" }}>
        <div style={{ padding: navCollapsed ? "14px 10px" : "16px 12px 14px 14px", borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: navCollapsed ? "center" : "space-between", gap: 8 }}>
          {navCollapsed ? (
            <button
              onClick={() => setNavCollapsed(false)}
              title="Expand menu"
              aria-label="Expand menu"
              style={{ width: 38, height: 34, borderRadius: 9, border: "1px solid rgba(255,255,255,.18)", background: "rgba(96,165,250,.16)", color: "#bfdbfe", font: "800 13px/1 var(--dn-font-sans)", cursor: "pointer" }}
            >
              NR
            </button>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <img src="/assets/docnexus-logo.png" alt="DocNexus" style={{ height: 17, flexShrink: 0 }} />
                <span style={{ flexShrink: 0, whiteSpace: "nowrap", font: "700 11px/1 var(--dn-font-sans)", padding: "4px 7px", background: "rgba(96,165,250,.22)", color: "#dbeafe", borderRadius: 6, border: "1px solid rgba(96,165,250,.35)" }}>NexusRep</span>
              </div>
              <button
                onClick={() => setNavCollapsed(true)}
                title="Collapse menu"
                aria-label="Collapse menu"
                style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.72)", font: "700 14px/1 var(--dn-font-sans)", cursor: "pointer" }}
              >
                ‹
              </button>
            </>
          )}
        </div>
        <nav style={{ flex: 1, overflowY: "auto", padding: navCollapsed ? "10px 8px" : 10, display: "flex", flexDirection: "column", gap: 1 }}>
          {NAV_PLAN.map((item) => <NavRow key={item.id} item={item} active={nav === item.id} collapsed={navCollapsed} onClick={() => setNav(item.id)} />)}
          <div style={{ height: 1, background: "rgba(255,255,255,.08)", margin: navCollapsed ? "12px 6px 4px" : "12px 8px 4px" }} />
          {!navCollapsed && <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".12em", color: "rgba(255,255,255,.38)", padding: "8px 12px 7px" }}>ACTIVITY</div>}
          {NAV_GOVERN.map((item) => <NavRow key={item.id} item={item} active={nav === item.id} collapsed={navCollapsed} onClick={() => setNav(item.id)} />)}
        </nav>
        <div style={{ padding: navCollapsed ? "8px 8px" : "8px 10px", borderTop: "1px solid rgba(255,255,255,.08)" }}>
          <div onClick={() => setNav("admin")} title={navCollapsed ? "Platform Admin" : undefined} style={{ display: "flex", alignItems: "center", justifyContent: navCollapsed ? "center" : "flex-start", gap: 10, padding: navCollapsed ? "10px 0" : "10px 13px", minHeight: 38, borderRadius: 9, cursor: "pointer", font: "500 13px/1.2 var(--dn-font-sans)", color: nav === "admin" ? "#fff" : "rgba(255,255,255,.6)", background: nav === "admin" ? "rgba(96,165,250,.18)" : "transparent" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#64748b" }} />{!navCollapsed && "Platform Admin"}
            {!navCollapsed && <span style={{ font: "500 9.5px/1 var(--dn-font-sans)", color: "rgba(255,255,255,.4)", marginLeft: "auto" }}>INTERNAL</span>}
          </div>
        </div>
        <div style={{ padding: navCollapsed ? "10px 8px" : "11px 14px", borderTop: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: navCollapsed ? "center" : "flex-start", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--dn-brand-light)", display: "flex", alignItems: "center", justifyContent: "center", font: "600 12px/1 var(--dn-font-sans)", color: "#fff" }}>JR</div>
          {!navCollapsed && <div style={{ lineHeight: 1.3 }}>
            <div style={{ font: "600 12px/1.2 var(--dn-font-sans)", color: "#fff" }}>J. Rivera</div>
            <div style={{ font: "400 11px/1.2 var(--dn-font-sans)", color: "rgba(255,255,255,.5)" }}>Brand Lead</div>
          </div>}
        </div>
      </aside>

      {/* MAIN COLUMN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{ height: 60, flexShrink: 0, background: "#fff", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", padding: "0 22px", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--dn-success)", boxShadow: "0 0 0 3px rgba(22,163,74,.15)" }} />
              <span style={{ font: "700 14px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{brand?.campaign.title ?? "AI Rep Studio"}</span>
            </div>
            <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", paddingLeft: 16 }}>{brand?.campaign.subtitle ?? ""}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, font: "600 11px/1 var(--dn-font-sans)", color: "#166534", background: "var(--dn-accent-green-bg)", padding: "6px 11px", borderRadius: 20 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--dn-success)" }} />Campaign live</span>
            {attention.length > 0 && (
              <span style={{ position: "relative" }}>
                <span onClick={() => setAttnOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, font: "600 11px/1 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", padding: "6px 11px", borderRadius: 20, cursor: "pointer" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--dn-warning)" }} />Needs attention: {attention.length}</span>
                {attnOpen && (
                  <div style={{ position: "absolute", top: 34, right: 0, width: 270, background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 11, boxShadow: "var(--dn-shadow-popover)", padding: 8, zIndex: 30 }}>
                    {attention.map((a, i) => (
                      <AttnItem key={a.label} n={String(i + 1)} label={a.label} onClick={() => { setAttnOpen(false); setNav(a.nav as Screen); }} />
                    ))}
                  </div>
                )}
              </span>
            )}
            <div style={{ width: 1, height: 26, background: "var(--dn-border)" }} />
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--dn-brand-base)", display: "flex", alignItems: "center", justifyContent: "center", font: "600 11px/1 var(--dn-font-sans)", color: "#fff" }}>JR</div>
          </div>
        </header>

        <main style={{ flex: 1, overflowY: "auto", position: "relative" }}>
          {nav === "overview" && <OverviewScreen app={app} />}
          {nav === "studio" && <StudioScreen app={app} />}
          {nav !== "overview" && nav !== "studio" && <BrandScreens app={app} />}
        </main>
      </div>
    </div>
  );
}

function NavRow({ item, active, collapsed, onClick }: { item: { id: Screen; label: string; badge?: string }; active: boolean; collapsed: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} title={collapsed ? item.label : undefined} style={{ display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "flex-start", gap: 10, padding: collapsed ? "10px 0" : "10px 13px", minHeight: 38, borderRadius: 9, font: `${active ? 600 : 500} 13px/1.2 var(--dn-font-sans)`, cursor: "pointer", position: "relative", color: active ? "#fff" : "rgba(255,255,255,.72)", background: active ? "rgba(96,165,250,.18)" : "transparent" }}>
      <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2, background: active ? "#60a5fa" : "transparent" }} />
      {collapsed ? <span style={{ font: "700 10px/1 var(--dn-font-sans)", letterSpacing: ".05em" }}>{item.label.slice(0, 2).toUpperCase()}</span> : item.label}
      {!collapsed && item.badge && <span style={{ marginLeft: "auto", font: "700 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", padding: "3px 6px", borderRadius: 5, background: "rgba(96,165,250,.22)", color: "#bfdbfe" }}>{item.badge}</span>}
    </div>
  );
}

function AttnItem({ n, label, onClick }: { n: string; label: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 11px", borderRadius: 8, cursor: "pointer" }}>
      <span style={{ font: "700 12px/1 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
      <span style={{ font: "500 12px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{label}</span>
    </div>
  );
}

type Metric = { key?: string; label: string; value: string; sub: string; tone: string };
type CommandKpi = { tone: string; label: string; value: string; sub: string };

// Real "needs attention" items, computed from live state (readiness gaps, pending coaching
// rules, CRM rows needing identity mapping) — never a hardcoded count.
export interface AttentionItem { label: string; nav: string }
function useAttention(): AttentionItem[] {
  const [items, setItems] = useState<AttentionItem[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const found: AttentionItem[] = [];
      try {
        const res = await fetch("/api/studio");
        if (res.ok) {
          const d = (await res.json()) as { readiness?: { items?: { label: string; done: boolean }[] }; rules?: { status: string }[] } | null;
          const open = (d?.readiness?.items ?? []).filter((i) => !i.done);
          if (open.length) found.push({ label: `${open.length} readiness item${open.length > 1 ? "s" : ""} open`, nav: "studio" });
          const pending = (d?.rules ?? []).filter((r) => r.status === "Draft" || r.status === "Needs review" || r.status === "Needs source").length;
          if (pending) found.push({ label: `${pending} coaching rule${pending > 1 ? "s" : ""} awaiting review`, nav: "studio" });
        }
      } catch { /* leave what we have */ }
      try {
        const res = await fetch("/api/followups");
        if (res.ok) {
          const d = (await res.json()) as { rows?: { status: string }[] };
          const mapping = (d.rows ?? []).filter((r) => r.status === "Needs mapping").length;
          if (mapping) found.push({ label: `${mapping} follow-up${mapping > 1 ? "s" : ""} need CRM identity mapping`, nav: "followups" });
        }
      } catch { /* leave what we have */ }
      if (alive) setItems(found);
    })();
    return () => { alive = false; };
  }, []);
  return items;
}

function useCommandKpis(): { kpis: CommandKpi[]; live: boolean } {
  const [kpis, setKpis] = useState<CommandKpi[]>(COMMAND_KPIS);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/analytics");
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Record<string, Metric[]> };
        if (!alive || !json.data) return;
        const d = json.data;
        const find = (cat: string, key: string) => (d[cat] ?? []).find((m) => m.key === key);
        const derived: CommandKpi[] = COMMAND_KPIS.map((fallback, i) => {
          const m = [
            find("engagement", "completed"),
            find("targeting", "high_opp"),
            find("crm_ops", "followups"),
            find("compliance", "isi"),
            find("content", "gaps"),
            find("crm_ops", "crm_success"),
          ][i];
          const label = [
            "Sessions completed", "Target HCPs", "Follow-ups created",
            "ISI delivery", "Content gaps", "CRM export success",
          ][i]!;
          return m
            ? { tone: m.tone ?? fallback.tone, label, value: m.value, sub: m.sub }
            : fallback;
        });
        setKpis(derived);
        setLive(true);
      } catch {
        /* keep static fallback — the caller labels it as sample data */
      }
    })();
    return () => { alive = false; };
  }, []);
  return { kpis, live };
}

function OverviewScreen({ app }: { app: AppState }) {
  const { kpis: commandKpis, live: kpisLive } = useCommandKpis();
  const brand = useBrand();
  // Real "needs coaching" list: sessions whose compliance status isn't clean, from the live API.
  const [coachRows, setCoachRows] = useState<{ id: string; hcp: string; comp: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rows?: { id: string; hcp: string; comp: string }[] } | null) => {
        if (!alive || !d?.rows) return;
        setCoachRows(d.rows.filter((s) => !/approved|clean/i.test(s.comp)).slice(0, 3));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const samplePill = (
    <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "#92400e", background: "var(--dn-accent-yellow-bg)", padding: "3px 7px", borderRadius: 5 }}>sample data</span>
  );
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1340 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ font: "600 11px/1.2 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--dn-brand-light)" }}>Command Center</span>
            {!kpisLive && samplePill}
          </div>
          <h1 style={{ font: "600 26px/1.2 var(--dn-font-sans)", letterSpacing: "-0.02em", margin: 0 }}>Good morning, Jordan</h1>
          <div style={{ font: "400 13px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 5 }}>{brand?.campaign.title ?? "AI Rep Studio"}</div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <button onClick={() => app.setNav("studio")} style={btnPrimary}>Open AI Rep Studio →</button>
          <button onClick={() => app.setNav("targeting")} style={btnGhost}>Review priority HCPs</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 13, marginBottom: 16 }}>
        {commandKpis.map((k) => (
          <div key={k.label} style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "15px 16px", boxShadow: "var(--dn-shadow-card)", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ font: "600 10.5px/1.3 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>{k.label}</span>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: TONE_COLORS[k.tone] }} />
            </div>
            <div style={{ font: "600 28px/1 var(--dn-font-sans)", letterSpacing: "-0.02em", color: TONE_COLORS[k.tone] }}>{k.value}</div>
            <div style={{ font: "400 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 6 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.62fr 1fr", gap: 16 }}>
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "18px 20px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ font: "600 13px/1 var(--dn-font-sans)" }}>What HCPs are asking</span>
            {samplePill}
          </div>
          <div style={{ font: "400 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 16 }}>Illustrative topic mix — per-topic session analytics land with the topic-distribution metric</div>
          {[["What the product is / mechanism", 100, "34%"], ["The program", 72, "23%"], ["Investigational & FDA status", 58, "19%"], ["Dosing / efficacy (→ Medical Info)", 44, "14%"], ["Comparative questions (→ Medical Info)", 32, "10%"]].map(([label, pct, val]) => (
            <div key={label as string} style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
              <span style={{ width: 150, flexShrink: 0, font: "500 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{label}</span>
              <span style={{ flex: 1, height: 13, borderRadius: 4, background: "var(--dn-surface-2)", overflow: "hidden" }}><span style={{ display: "block", height: "100%", borderRadius: 4, background: "var(--dn-brand-light)", width: `${pct}%` }} /></span>
              <span style={{ width: 40, textAlign: "right", font: "600 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{val}</span>
            </div>
          ))}
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "18px 20px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 13px/1 var(--dn-font-sans)", marginBottom: 12 }}>Sessions needing coaching</div>
          {/* REAL sessions with a non-clean compliance status — never fixture doctors. */}
          {(coachRows ?? []).map((s) => (
            <div key={s.id} onClick={() => { app.setSelectedSessionId(String(s.id)); app.setNav("audit"); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--dn-surface-2)", cursor: "pointer" }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--dn-surface-2)", display: "flex", alignItems: "center", justifyContent: "center", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{s.hcp.split(" ").slice(-1)[0]?.[0]}</span>
              <div style={{ flex: 1 }}>
                <div style={{ font: "600 12px/1.2 var(--dn-font-sans)" }}>{s.hcp}</div>
                <div style={{ font: "400 10.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{s.comp}</div>
              </div>
              <span style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)" }}>Review →</span>
            </div>
          ))}
          {coachRows !== null && coachRows.length === 0 && (
            <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "10px 0" }}>Nothing flagged — every reviewed session is clean.</div>
          )}
          {coachRows === null && (
            <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "10px 0" }}>Loading sessions…</div>
          )}
        </div>
      </div>
    </div>
  );
}

export const btnPrimary: React.CSSProperties = { padding: "11px 18px", background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" };
export const btnGhost: React.CSSProperties = { padding: "11px 18px", background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" };
