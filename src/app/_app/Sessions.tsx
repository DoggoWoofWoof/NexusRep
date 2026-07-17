"use client";

import { useEffect, useState } from "react";
import { type AppState } from "./NexusRepApp";
import { card, cell, eyebrow, h1 } from "./ui";
import { compStyle, TRAIN_SEED_KEY } from "./data";

export type SessionRow = {
  id: number | string;
  hcp: string;
  date: string;
  duration: string;
  questions: number | string;
  comp: string;
  compTone: "green" | "yellow" | "pink" | "red";
  hasRecording?: boolean;
  followup: string;
};

export function Sessions({ app }: { app: AppState }) {
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
            No sessions yet — start one in <strong style={{ color: "var(--dn-fg)" }}>Preview HCP experience</strong> (Text, Voice, or Video).
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
              <button type="button" data-testid="review-session" data-session-id={String(s.id)} onClick={() => { app.setSelectedSessionId(String(s.id)); app.setNav("audit"); }} style={{ padding: "6px 9px", background: "rgba(6,73,172,.08)", color: "var(--dn-brand-base)", border: "none", borderRadius: 7, font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}>Review</button>
              <span onClick={() => {
                app.setSelectedSessionId(String(s.id));
                try { window.localStorage.setItem(TRAIN_SEED_KEY, JSON.stringify({ mode: "session", sessionId: String(s.id) })); } catch { /* storage disabled — Training still opens */ }
                app.setStudioMode("train");
                app.setNav("studio");
              }} style={{ padding: "6px 9px", background: "#fff", border: "1px solid var(--dn-border)", color: "var(--dn-fg-muted)", borderRadius: 7, font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}>Coach</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===================== ANALYTICS ===================== */
