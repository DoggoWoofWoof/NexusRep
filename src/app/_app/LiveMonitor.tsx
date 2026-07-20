"use client";

/**
 * Live-monitoring banner for the brand rep. Polls /api/sessions/live every few seconds and, when a live
 * conversation has requested a HUMAN, raises a prominent take-over alert; it also shows each live call's
 * latest utterance as a rolling preview (the transcript itself streams turn-by-turn, so this trails real
 * time by a poll). Sits between the header and the content so the rep sees it wherever they are. Renders
 * nothing when no conversation is live.
 */

import { useEffect, useState } from "react";
import { type AppState } from "./NexusRepApp";

type LiveSession = {
  id: string;
  hcp: string;
  complianceStatus: string;
  turns: number;
  lastSpeaker: "hcp" | "rep" | null;
  lastText: string;
  startedAt: string;
  needsHuman: boolean;
};
type LiveResp = { live: LiveSession[]; needsHumanCount: number };

export function LiveMonitor({ app }: { app: AppState }) {
  const [live, setLive] = useState<LiveSession[]>([]);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetch("/api/sessions/live")
        .then((r) => (r.ok ? (r.json() as Promise<LiveResp>) : null))
        .then((d) => { if (alive && d) setLive(d.live ?? []); })
        .catch(() => { /* transient — keep the last snapshot */ });
    void poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (live.length === 0) return null;

  const needsHuman = live.filter((s) => s.needsHuman);
  const watching = live.filter((s) => !s.needsHuman);
  const open = (id: string) => { app.setSelectedSessionId(id); app.setNav("audit"); };
  const preview = (s: LiveSession) => (s.lastText ? `${s.lastSpeaker === "hcp" ? "HCP" : "Rep"}: ${s.lastText}` : "…");

  return (
    <div style={{ flexShrink: 0 }}>
      {needsHuman.length > 0 && (
        <div style={{ background: "#fdecec", borderBottom: "1px solid #f0a3a3", padding: "9px 22px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, font: "700 12.5px/1.2 var(--dn-font-sans)", color: "#8a1f1f", whiteSpace: "nowrap" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#dc2626", boxShadow: "0 0 0 3px rgba(220,38,38,.18)" }} />
            {needsHuman.length} live conversation{needsHuman.length > 1 ? "s" : ""} need a human
          </span>
          {needsHuman.slice(0, 4).map((s) => (
            <button key={s.id} onClick={() => open(s.id)} title={preview(s)} style={{ font: "600 11.5px/1 var(--dn-font-sans)", color: "#8a1f1f", background: "#fff", border: "1px solid #f0a3a3", borderRadius: 7, padding: "6px 11px", cursor: "pointer", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.hcp} · take over →
            </button>
          ))}
        </div>
      )}
      {watching.length > 0 && (
        <div style={{ background: "var(--dn-accent-green-bg)", borderBottom: "1px solid var(--dn-border)", padding: "7px 22px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", font: "500 11px/1.3 var(--dn-font-sans)", color: "#166534" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap", fontWeight: 700 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--dn-success)" }} />
            {watching.length} live now
          </span>
          {watching.slice(0, 3).map((s) => (
            <button key={s.id} onClick={() => open(s.id)} style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "500 10.5px/1.2 var(--dn-font-sans)", color: "#166534", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 6, padding: "4px 9px", cursor: "pointer", maxWidth: 380, overflow: "hidden" }}>
              <strong style={{ whiteSpace: "nowrap" }}>{s.hcp}</strong>
              <span style={{ color: "var(--dn-fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
