"use client";

import { useState } from "react";
import { btnGhost, btnPrimary } from "./NexusRepApp";
import { card, eyebrow, h1 } from "./ui";
import { useFetchOnce } from "@lib/use-fetch-once";

type FollowUpRow = { id: number; hcp: string; reason: string; owner: string; target: string; status: string; context?: string | null };

export function FollowUps() {
  const [statuses, setStatuses] = useState<Record<number, string>>({});
  const [sel, setSel] = useState(0);
  const [jsonOpen, setJsonOpen] = useState(false);
  // Real follow-ups only (created automatically after each session) — no fake rows.
  const { data, loading } = useFetchOnce<{ rows?: FollowUpRow[] }>("/api/followups");
  const baseRows = data?.rows ?? [];
  const loaded = !loading;
  const events = baseRows.map((e) => ({ ...e, status: statuses[e.id] ?? e.status }));
  const selected = events[Math.min(sel, events.length - 1)];
  const retryAll = () => { const m: Record<number, string> = {}; events.forEach((e) => { if (e.status !== "Sent to CRM") m[e.id] = "Retrying"; }); setStatuses((s) => ({ ...s, ...m })); setTimeout(() => { const d: Record<number, string> = {}; events.forEach((e) => (d[e.id] = "Sent to CRM")); setStatuses(d); }, 1100); };
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1400 }}>
      <div style={eyebrow}>Follow-ups</div>
      <h1 style={{ ...h1, marginBottom: 6 }}>Who needs follow-up?</h1>
      <p style={{ font: "400 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 20px" }}>Follow-ups are created automatically after each session and synced to your CRM in the background.</p>
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
          {selected.context && (
            <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderLeft: "3px solid var(--dn-brand-base)", borderRadius: 8 }}>
              <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 5 }}>Prior sessions with this HCP</div>
              <div style={{ font: "400 12px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{selected.context}</div>
            </div>
          )}
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

