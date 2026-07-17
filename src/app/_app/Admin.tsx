"use client";

import { useEffect, useState } from "react";
import { card, h1 } from "./ui";
import { CRM_CONNECTORS, VENDOR_STACK } from "./data";

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

export function Admin() {
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
        conversation — open <strong>AI Rep → Training → ⚙ Model lab</strong>.
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

