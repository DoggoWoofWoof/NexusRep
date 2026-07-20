"use client";

/**
 * Live takeover panel — shown at the top of Session review for an in-progress conversation. The rep sees
 * the transcript streaming (polled every 3s), can TAKE OVER (from then the AI stops answering), REPLY
 * directly to the doctor (human trusted — delivered as-is, fully logged), and HAND BACK to the AI. Self-
 * gates: renders nothing unless the session is live, so it's inert for reviewed/ended sessions.
 */

import { useEffect, useRef, useState } from "react";
import { card } from "./ui";

type Turn = { speaker: "hcp" | "rep"; text: string; human?: boolean; at?: string | null };
type Detail = { session: { hcp: string; live: boolean; takenOverBy: string | null }; turns: Turn[] };

export function LiveTakeover({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = () =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Detail>) : null))
      .then((d) => { if (d) setDetail(d); })
      .catch(() => {});

  useEffect(() => {
    let alive = true;
    const poll = () => { if (alive) void refresh(); };
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [detail?.turns.length]);

  if (!detail?.session.live) return null; // only for a live conversation

  const takenOverBy = detail.session.takenOverBy;
  const act = async (action: "take" | "reply" | "hand_back", text?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/conversation/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, action, ...(text ? { text } : {}) }),
      });
      if (res.ok) { if (action === "reply") setReply(""); await refresh(); }
    } finally { setBusy(false); }
  };

  return (
    <div style={{ ...card, padding: "14px 16px", marginBottom: 16, border: takenOverBy ? "1px solid #f0a3a3" : "1px solid var(--dn-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#dc2626", boxShadow: "0 0 0 3px rgba(220,38,38,.18)" }} />
        <strong style={{ font: "700 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>LIVE · {detail.session.hcp}</strong>
        <span style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: takenOverBy ? "#8a1f1f" : "var(--dn-fg-muted)", background: takenOverBy ? "#fdecec" : "var(--dn-surface)", padding: "4px 9px", borderRadius: 12 }}>
          {takenOverBy ? `Human takeover · ${takenOverBy}` : "AI is answering"}
        </span>
        {!takenOverBy ? (
          <button onClick={() => act("take")} disabled={busy} style={btn("#8a1f1f", "#fff", "#f0a3a3")}>Take over</button>
        ) : (
          <button onClick={() => act("hand_back")} disabled={busy} style={{ ...btn("var(--dn-fg-muted)", "var(--dn-surface)", "var(--dn-border)"), marginLeft: "auto" }}>Hand back to AI</button>
        )}
      </div>

      <div ref={scrollRef} style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: "4px 2px" }}>
        {detail.turns.map((t, i) => (
          <div key={i} style={{ alignSelf: t.speaker === "hcp" ? "flex-start" : "flex-end", maxWidth: "82%", padding: "7px 11px", borderRadius: 10, font: "400 12px/1.4 var(--dn-font-sans)", background: t.speaker === "hcp" ? "var(--dn-surface)" : t.human ? "#fdecec" : "var(--dn-brand-base)", color: t.speaker === "hcp" ? "var(--dn-fg)" : t.human ? "#8a1f1f" : "#fff" }}>
            <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", opacity: 0.7, display: "block", marginBottom: 3 }}>{t.speaker === "hcp" ? "HCP" : t.human ? "You (human)" : "AI rep"}</span>
            {t.text || <em style={{ opacity: 0.6 }}>…held for you</em>}
          </div>
        ))}
      </div>

      {takenOverBy && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply directly to the doctor… (sent as-is, logged)" rows={2} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reply.trim()) void act("reply", reply.trim()); }} style={{ flex: 1, resize: "vertical", padding: "8px 10px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg)", background: "#fff" }} />
          <button onClick={() => reply.trim() && act("reply", reply.trim())} disabled={busy || !reply.trim()} style={{ ...btn("#fff", "var(--dn-brand-base)", "var(--dn-brand-base)"), alignSelf: "stretch", opacity: busy || !reply.trim() ? 0.5 : 1 }}>Send</button>
        </div>
      )}
    </div>
  );
}

function btn(color: string, bg: string, border: string): React.CSSProperties {
  return { font: "600 11.5px/1 var(--dn-font-sans)", color, background: bg, border: `1px solid ${border}`, borderRadius: 7, padding: "7px 13px", cursor: "pointer" };
}
