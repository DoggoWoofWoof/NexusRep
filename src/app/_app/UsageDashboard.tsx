"use client";

/**
 * Admin → Usage & cost. Reads /api/usage (the process-global vendor ledger) and shows the full cost
 * picture: totals, a cumulative spend trend + per-day bars, cost split by vendor / operation, and
 * per-user + per-session attribution. Admin-only (the route enforces it too). Counts are vendor-exact;
 * $ is a list-price estimate. In-memory today, so it resets on restart (durable with managed Postgres).
 */

import { useEffect, useState } from "react";
import { card, eyebrow, h1 } from "./ui";

type Day = { date: string; events: number; estCostUsd: number; inputTokens: number; outputTokens: number; chars: number; seconds: number; cumulativeCostUsd: number };
type UsageResp = {
  summary: { events: number; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; byVendor: Record<string, number>; byOperation: Record<string, number>; byUser: Record<string, number>; rollups: { vendor: string; operation: string; requests: number; chars: number; seconds: number; estCostUsd: number }[] };
  perUser: { owner: string; events: number; estCostUsd: number }[];
  perSession: { sessionId: string; events: number; estCostUsd: number }[];
  perDay: Day[];
};

const VENDOR_LABEL: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", tavus: "Tavus", elevenlabs: "ElevenLabs", other: "Other" };
const VENDOR_COLOR: Record<string, string> = { anthropic: "#d97757", openai: "#10a37f", tavus: "#6366f1", elevenlabs: "#f59e0b", other: "#94a3b8" };
const OP_LABEL: Record<string, string> = { classify: "Classifier", compose: "Answer LLM", setup: "Setup helper", tts: "Voice (TTS)", asr: "Transcription", video: "Video" };

function usd(n: number): string {
  if (!n) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}
const num = (n: number): string => n.toLocaleString("en-US");

/** Cumulative spend as a filled area + line. Uniform scaling keeps the markers round. */
function CumulativeChart({ days }: { days: Day[] }) {
  const W = 680, H = 150, P = 10;
  const max = Math.max(...days.map((d) => d.cumulativeCostUsd), 0.0001);
  const n = days.length;
  const x = (i: number) => (n <= 1 ? W / 2 : P + (i / (n - 1)) * (W - 2 * P));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = days.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.cumulativeCostUsd).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <path d={area} fill="rgba(96,165,250,.14)" />
      <path d={line} fill="none" stroke="var(--dn-brand-base)" strokeWidth={2} strokeLinejoin="round" />
      {days.map((d, i) => <circle key={i} cx={x(i)} cy={y(d.cumulativeCostUsd)} r={2.4} fill="var(--dn-brand-base)" />)}
    </svg>
  );
}

/** Per-day cost bars (each day's spend, not cumulative). */
function DailyBars({ days }: { days: Day[] }) {
  const max = Math.max(...days.map((d) => d.estCostUsd), 0.0001);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 116, overflowX: "auto" }}>
      {days.map((d, i) => (
        <div key={i} title={`${d.date} — ${usd(d.estCostUsd)} · ${num(d.events)} calls`} style={{ flex: "1 0 18px", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", gap: 5, minWidth: 18 }}>
          <div style={{ width: "100%", maxWidth: 30, height: `${Math.max(2, (d.estCostUsd / max) * 92)}%`, background: "var(--dn-brand-base)", borderRadius: "3px 3px 0 0" }} />
          <span style={{ font: "400 8px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", whiteSpace: "nowrap" }}>{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal cost bars (vendor / operation split). */
function HBars({ rows, color }: { rows: { label: string; value: number }[]; color?: (label: string) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  if (rows.length === 0) return <div style={{ font: "400 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Nothing yet.</div>;
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
          <span style={{ width: 84, font: "500 11px/1.2 var(--dn-font-sans)", color: "var(--dn-fg-muted)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
          <div style={{ flex: 1, background: "var(--dn-surface)", borderRadius: 4, height: 15, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, height: "100%", background: color?.(r.label) ?? "var(--dn-brand-base)", borderRadius: 4 }} />
          </div>
          <span style={{ width: 60, textAlign: "right", font: "700 11px/1 var(--dn-font-sans)", color: "var(--dn-fg)", fontVariantNumeric: "tabular-nums" }}>{usd(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...card, padding: "14px 16px", flex: "1 1 160px" }}>
      <div style={{ font: "600 9.5px/1 var(--dn-font-sans)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 8 }}>{label}</div>
      <div style={{ font: "700 22px/1 var(--dn-font-sans)", color: "var(--dn-fg)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ font: "400 10.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: "15px 17px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={eyebrow}>{title}</div>
        {right && <span style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", fontVariantNumeric: "tabular-nums" }}>{right}</span>}
      </div>
      {children}
    </div>
  );
}

export function UsageDashboard() {
  const [data, setData] = useState<UsageResp | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: UsageResp | null) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const s = data?.summary;
  const hasData = !!s && s.events > 0;
  const vendorRows = s ? Object.entries(s.byVendor).map(([k, v]) => ({ label: VENDOR_LABEL[k] ?? k, value: v, key: k })).sort((a, b) => b.value - a.value) : [];
  const opRows = s ? Object.entries(s.byOperation).map(([k, v]) => ({ label: OP_LABEL[k] ?? k, value: v })).sort((a, b) => b.value - a.value) : [];

  return (
    <div style={{ padding: "24px 30px 48px", maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={eyebrow}>Platform · internal</div>
          <h1 style={{ ...h1, marginBottom: 4 }}>Usage &amp; cost</h1>
          <p style={{ font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: 0 }}>Every paid vendor call — Claude &amp; OpenAI tokens, TTS characters, Tavus video minutes — attributed per user and per conversation. Counts are exact; $ is a list-price estimate.</p>
        </div>
        <button onClick={load} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--dn-border)", background: "var(--dn-surface)", color: "var(--dn-fg)", font: "600 12px/1 var(--dn-font-sans)", cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1 }}>{loading ? "Loading…" : "↻ Refresh"}</button>
      </div>

      {!hasData ? (
        <div style={{ ...card, padding: "40px 24px", marginTop: 20, textAlign: "center" }}>
          <div style={{ font: "600 14px/1.4 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 6 }}>{loading ? "Loading usage…" : "No vendor usage recorded yet"}</div>
          {!loading && <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", maxWidth: 460, margin: "0 auto" }}>Cost appears here once the rep runs with real vendor keys (Anthropic / OpenAI / Tavus). With the mock/keyless demo stack, answers are served without a paid call — so there is nothing to bill.</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 20 }}>
          {/* Totals */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Stat label="Total est. cost" value={usd(s!.totalCostUsd)} sub={`${num(s!.events)} vendor calls`} />
            <Stat label="LLM tokens" value={num(s!.totalInputTokens + s!.totalOutputTokens)} sub={`${num(s!.totalInputTokens)} in · ${num(s!.totalOutputTokens)} out`} />
            <Stat label="Users tracked" value={num(data!.perUser.length)} sub="brand accounts with spend" />
            <Stat label="Conversations" value={num(data!.perSession.length)} sub="sessions with vendor cost" />
          </div>

          {/* Trend + per-day */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <Panel title="Cumulative spend" right={usd(s!.totalCostUsd)}><CumulativeChart days={data!.perDay} /></Panel>
            <Panel title="Cost per day"><DailyBars days={data!.perDay} /></Panel>
          </div>

          {/* Vendor + operation split */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <Panel title="Cost by vendor"><HBars rows={vendorRows} color={(l) => VENDOR_COLOR[Object.keys(VENDOR_LABEL).find((k) => VENDOR_LABEL[k] === l) ?? "other"] ?? "var(--dn-brand-base)"} /></Panel>
            <Panel title="Cost by operation"><HBars rows={opRows} /></Panel>
          </div>

          {/* Per-user attribution */}
          <Panel title="Cost by user" right={`${num(data!.perUser.length)} users`}>
            <div>
              {data!.perUser.map((u, i) => (
                <div key={u.owner} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: i ? "1px solid var(--dn-border)" : "none", font: "400 12px/1.3 var(--dn-font-sans)" }}>
                  <span style={{ width: 22, color: "var(--dn-fg-subtle)", fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
                  <span style={{ flex: 1, fontWeight: 600, color: "var(--dn-fg)" }}>{u.owner === "__default__" || u.owner === "default" ? "Shared / doctor link" : u.owner}</span>
                  <span style={{ color: "var(--dn-fg-muted)", fontVariantNumeric: "tabular-nums" }}>{num(u.events)} calls</span>
                  <span style={{ width: 74, textAlign: "right", fontWeight: 700, color: "var(--dn-fg)", fontVariantNumeric: "tabular-nums" }}>{usd(u.estCostUsd)}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* Top sessions */}
          <Panel title="Most expensive conversations" right={`top ${Math.min(12, data!.perSession.length)}`}>
            <div>
              {data!.perSession.slice(0, 12).map((se, i) => (
                <div key={se.sessionId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: i ? "1px solid var(--dn-border)" : "none", font: "400 12px/1.3 var(--dn-font-sans)" }}>
                  <span style={{ width: 22, color: "var(--dn-fg-subtle)", fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
                  <span style={{ flex: 1, fontFamily: "var(--dn-font-mono)", fontSize: 11, color: "var(--dn-brand-base)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{se.sessionId}</span>
                  <span style={{ color: "var(--dn-fg-muted)", fontVariantNumeric: "tabular-nums" }}>{num(se.events)} calls</span>
                  <span style={{ width: 74, textAlign: "right", fontWeight: 700, color: "var(--dn-fg)", fontVariantNumeric: "tabular-nums" }}>{usd(se.estCostUsd)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <div style={{ font: "400 10.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
            Token / character / minute counts are reported by the vendor (exact). Dollar figures are directional estimates from a list-price table (editable per model). Ledger is in-memory and resets on restart — it becomes a durable history with the managed-Postgres step.
          </div>
        </div>
      )}
    </div>
  );
}
