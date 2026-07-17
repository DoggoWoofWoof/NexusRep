"use client";

/**
 * Admin → Activity: a live, filterable timeline of EVERYTHING happening in the app (every click,
 * navigation, API call, upload, update, connection, session/video lifecycle, compliance decision,
 * recording, CRM, follow-up) — the in-app replacement for tailing the host console. Polls
 * /api/activity every ~2s (pausable) and renders newest-first with per-event detail. Internal /
 * platform-admin only; the doctor view never renders the sidebar this lives in.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActivityEvent, ActivitySummary } from "@modules/activity";

const POLL_MS = 2000;

// Category → chip colours. Light background + readable text; distinct enough to scan at a glance.
const CAT_COLOR: Record<string, { bg: string; fg: string }> = {
  auth: { bg: "#eef2ff", fg: "#4338ca" },
  navigation: { bg: "#f1f5f9", fg: "#475569" },
  click: { bg: "#f3f4f6", fg: "#6b7280" },
  api: { bg: "#eff6ff", fg: "#1d4ed8" },
  content: { bg: "#ecfeff", fg: "#0e7490" },
  training: { bg: "#faf5ff", fg: "#7e22ce" },
  audience: { bg: "#ecfdf5", fg: "#047857" },
  launch: { bg: "#f0fdf4", fg: "#15803d" },
  session: { bg: "#fffbeb", fg: "#b45309" },
  video: { bg: "#fdf2f8", fg: "#be185d" },
  compliance: { bg: "#fff7ed", fg: "#c2410c" },
  recording: { bg: "#f5f3ff", fg: "#6d28d9" },
  followup: { bg: "#f7fee7", fg: "#4d7c0f" },
  crm: { bg: "#f0f9ff", fg: "#0369a1" },
  system: { bg: "#f4f4f5", fg: "#52525b" },
};
const catColor = (c: string) => CAT_COLOR[c] ?? CAT_COLOR.system!;

const SEV_DOT: Record<string, string> = { info: "transparent", notice: "#3b82f6", warn: "#f59e0b", error: "#ef4444" };

function relTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const card: React.CSSProperties = { background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)" };

interface Filters {
  q: string;
  user: string;
  category: string;
  surface: string;
  severity: string;
}
const EMPTY: Filters = { q: "", user: "", category: "", surface: "", severity: "" };

export function ActivityDashboard() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState<number>(() => Date.now());
  const [err, setErr] = useState<string>("");

  const load = useCallback(async () => {
    const f = filters;
    const p = new URLSearchParams({ limit: "300" });
    if (f.q) p.set("q", f.q);
    if (f.user) p.set("user", f.user);
    if (f.category) p.set("category", f.category);
    if (f.surface) p.set("surface", f.surface);
    if (f.severity) p.set("severity", f.severity);
    try {
      const res = await fetch(`/api/activity?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { events: ActivityEvent[]; summary: ActivitySummary };
      setEvents(data.events);
      setSummary(data.summary);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [filters]);

  // Refetch immediately when filters change (load is recreated when filters change).
  useEffect(() => { void load(); }, [load]);

  // Live polling (pausable) + a 1s clock so relative times stay fresh.
  useEffect(() => {
    if (!live) return;
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(poll);
  }, [live, load]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const topCategories = useMemo(() => {
    if (!summary) return [];
    return Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [summary]);

  const activeFilters = filters.q || filters.user || filters.category || filters.surface || filters.severity;

  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "#fff", background: "#475569", padding: "5px 10px", borderRadius: 6 }}>Internal · Activity monitor</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "600 11px/1 var(--dn-font-sans)", color: live ? "#15803d" : "var(--dn-fg-subtle)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: live ? "#22c55e" : "#cbd5e1", boxShadow: live ? "0 0 0 3px rgba(34,197,94,.18)" : "none" }} />
          {live ? "Live" : "Paused"}
        </span>
      </div>
      <h1 style={{ font: "600 24px/1.2 var(--dn-font-sans)", letterSpacing: "-0.02em", margin: "0 0 6px", color: "var(--dn-fg)" }}>Activity</h1>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 18px", maxWidth: 760 }}>
        Every click, connection, and event across the app — brand console and doctor sessions — captured live, so you never need the server console. Newest first{err ? ` · couldn't refresh: ${err}` : ""}.
      </p>

      {/* Summary tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Tile label="Events retained" value={summary?.total ?? 0} />
        <Tile label="Active users" value={summary?.users.length ?? 0} />
        <Tile label="Event types" value={summary?.categories.length ?? 0} />
        <Tile label="Errors" value={summary?.errors ?? 0} tone={summary && summary.errors > 0 ? "error" : undefined} />
        <Tile label={activeFilters ? "Matching filter" : "Showing"} value={summary?.shown ?? events.length} />
      </div>

      {/* Filter bar */}
      <div style={{ ...card, padding: "12px 14px", marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <input
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          placeholder="Search actions, targets, users, details…"
          aria-label="Search activity"
          style={{ flex: "1 1 240px", minWidth: 200, padding: "8px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 12.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg)", background: "var(--dn-surface)" }}
        />
        <Select label="User" value={filters.user} onChange={(v) => setFilters((f) => ({ ...f, user: v }))} options={summary?.users ?? []} />
        <Select label="Category" value={filters.category} onChange={(v) => setFilters((f) => ({ ...f, category: v }))} options={summary?.categories ?? []} />
        <Select label="Surface" value={filters.surface} onChange={(v) => setFilters((f) => ({ ...f, surface: v }))} options={["brand", "doctor", "server"]} />
        <Select label="Severity" value={filters.severity} onChange={(v) => setFilters((f) => ({ ...f, severity: v }))} options={["info", "notice", "warn", "error"]} />
        {activeFilters ? (
          <button onClick={() => setFilters(EMPTY)} style={pill(false)}>Clear</button>
        ) : null}
        <div style={{ flex: "1 0 0" }} />
        <button onClick={() => setLive((v) => !v)} data-activity={live ? "Pause activity" : "Resume activity"} style={pill(live)}>{live ? "⏸ Pause" : "▶ Live"}</button>
        <button onClick={() => void load()} data-activity="Refresh activity" style={pill(false)}>↻ Refresh</button>
      </div>

      {/* Category quick-filter chips */}
      {topCategories.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 14 }}>
          {topCategories.map(([c, n]) => {
            const col = catColor(c);
            const on = filters.category === c;
            return (
              <button
                key={c}
                onClick={() => setFilters((f) => ({ ...f, category: on ? "" : c }))}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, border: on ? `1.5px solid ${col.fg}` : "1px solid var(--dn-border)", background: col.bg, color: col.fg, font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}
              >
                {c}<span style={{ opacity: 0.7, fontWeight: 500 }}>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Timeline */}
      <div style={{ ...card, overflow: "hidden" }}>
        {events.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
            {activeFilters ? "No events match these filters." : "No activity yet — interact with the app and it'll appear here live."}
          </div>
        ) : (
          events.map((e) => {
            const col = catColor(e.category);
            const open = expanded.has(e.id);
            return (
              <div key={e.id} style={{ borderBottom: "1px solid var(--dn-surface-2)" }}>
                <div
                  onClick={() => toggle(e.id)}
                  style={{ display: "grid", gridTemplateColumns: "78px 108px 1fr auto", gap: 12, alignItems: "center", padding: "9px 14px", cursor: "pointer" }}
                >
                  <span title={new Date(e.at).toLocaleString()} style={{ font: "400 11px/1.3 var(--dn-font-mono, var(--dn-font-sans))", color: "var(--dn-fg-subtle)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{relTime(e.at, now)}</span>
                  <span style={{ display: "inline-flex", justifySelf: "start", alignItems: "center", padding: "3px 9px", borderRadius: 20, background: col.bg, color: col.fg, font: "600 10.5px/1 var(--dn-font-sans)", whiteSpace: "nowrap" }}>{e.category}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    {SEV_DOT[e.severity] && e.severity !== "info" ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: SEV_DOT[e.severity], flexShrink: 0 }} /> : null}
                    <span style={{ font: "600 12.5px/1.35 var(--dn-font-sans)", color: "var(--dn-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.action}</span>
                    {e.target ? <span style={{ font: "400 12px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>· {e.target}</span> : null}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                    <span style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", background: "var(--dn-surface-2)", padding: "3px 8px", borderRadius: 6 }}>{e.user}</span>
                    <span style={{ font: "400 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{e.surface}</span>
                    <span style={{ color: "var(--dn-fg-subtle)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
                  </span>
                </div>
                {open && (
                  <div style={{ padding: "2px 14px 14px 90px", display: "flex", flexWrap: "wrap", gap: "6px 22px" }}>
                    <Detail k="Time" v={new Date(e.at).toLocaleString()} />
                    <Detail k="Seq" v={String(e.seq)} />
                    {e.sessionId ? <Detail k="Session" v={e.sessionId} /> : null}
                    {e.metadata
                      ? Object.entries(e.metadata).map(([k, v]) => <Detail key={k} k={k} v={typeof v === "object" ? JSON.stringify(v) : String(v)} />)
                      : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "error" }) {
  return (
    <div style={{ ...card, padding: "14px 16px" }}>
      <div style={{ font: "700 24px/1 var(--dn-font-sans)", color: tone === "error" ? "#dc2626" : "var(--dn-fg)", fontVariantNumeric: "tabular-nums" }}>{value.toLocaleString()}</div>
      <div style={{ font: "500 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      style={{ padding: "8px 9px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 12px/1.2 var(--dn-font-sans)", color: value ? "var(--dn-fg)" : "var(--dn-fg-subtle)", background: "var(--dn-surface)", cursor: "pointer" }}
    >
      <option value="">{label}: all</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)" }}>
      <span style={{ color: "var(--dn-fg-subtle)" }}>{k}: </span>
      <span style={{ color: "var(--dn-fg)", fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "7px 12px",
    borderRadius: 8,
    border: `1px solid ${active ? "var(--dn-brand-base)" : "var(--dn-border)"}`,
    background: active ? "var(--dn-brand-base)" : "#fff",
    color: active ? "#fff" : "var(--dn-fg)",
    font: "600 12px/1 var(--dn-font-sans)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
