"use client";

import { useEffect, useState } from "react";
import { btnGhost, btnPrimary, type AppState } from "./NexusRepApp";
import { card, cell, eyebrow, h1 } from "./ui";
import { segStyle } from "./data";
import { useAudience } from "./useAudience";

export function Launch({ app }: { app: AppState }) {
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
  const previewHcpId = rows[0]?.id ?? listIds[0] ?? app.sessionHcpId ?? "";
  const previewDoctorView = () => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (previewHcpId) params.set("hcp", previewHcpId);
    params.set("preview", "launch");
    window.location.assign(`/hcp?${params.toString()}`);
  };
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
            <button onClick={previewDoctorView} style={{ width: "100%", marginTop: 9, padding: 11, background: "#fff", color: "var(--dn-brand-base)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer" }}>Preview doctor view ↗</button>
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
