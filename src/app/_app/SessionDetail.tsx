"use client";

import { useEffect, useRef, useState } from "react";
import { type AppState } from "./NexusRepApp";
import { card, eyebrow, h1 } from "./ui";
import { TRAIN_SEED_KEY } from "./data";
import { SlideView } from "../_components/SlideView";
import { mmss } from "@lib/format";
import { type SessionRow } from "./Sessions";

type SessionDetailData = {
  session: { hcp: string; startedAt: string; durationSeconds: number; questionCount: number; complianceStatus: string; recordingUrl?: string | null; recordingDurationMs?: number | null; timelineSource?: "recorded" | null };
  turns: { speaker: "hcp" | "rep"; text: string; sourceIds: string[]; detailAidSlideId?: string | null; at?: string | null }[];
  audit: { seq: number; type: string; payload: Record<string, unknown> }[];
  hasTurnDetail: boolean;
};
const COMP_LABEL: Record<string, string> = { approved: "Approved", needs_review: "Needs review", ae_routed: "AE routed", blocked_escalated: "Blocked + escalated" };
const TRACE = ["Input (text / ASR)", "Intent + risk classifier", "Policy router", "Approved retrieval + source validation", "Response builder / grounding", "Final compliance gate", "Output + audit + follow-up"];
const REVIEW_SLIDE_CUE_DELAY_SEC = 1.1;

export function SessionDetail({ app }: { app: AppState }) {
  const [sel, setSel] = useState(0);
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const metadataFixingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const [nowSec, setNowSec] = useState(0);
  // Real recording length once the video's metadata resolves — used to scale the transcript/slide
  // timeline to the video so they track it end-to-end (0 until known / no recording).
  const [vidDur, setVidDur] = useState(0);
  // The recording URL was present but the <video> failed to load it (truncated / corrupted clip, or
  // the file isn't on this instance) — surfaced honestly instead of a silent black pane.
  const [videoError, setVideoError] = useState(false);
  useEffect(() => {
    let alive = true;
    setDetail(null); setSel(0); setNowSec(0); setVidDur(0); setVideoError(false);
    setLoading(true);
    setLoadError("");
    const openLatestReviewable = async () => {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error("sessions unavailable");
      const json = (await res.json()) as { rows?: SessionRow[] };
      const latest = json.rows?.[0];
      if (alive && latest?.id) app.setSelectedSessionId(String(latest.id));
      else if (alive) setLoadError("No reviewable sessions yet.");
    };
    (async () => {
      try {
        if (!app.selectedSessionId) {
          await openLatestReviewable();
          return;
        }
        const res = await fetch(`/api/sessions/${encodeURIComponent(app.selectedSessionId!)}`);
        if (!res.ok) {
          await openLatestReviewable();
          return;
        }
        const json = (await res.json()) as SessionDetailData;
        if (alive) setDetail(json);
      } catch {
        if (alive) setLoadError("Couldn't load this session review.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [app.selectedSessionId]);

  // Pair the real turns into HCP→rep exchanges.
  const exchanges: { q: string; a: string; sourceIds: string[] }[] = [];
  const turns = detail?.turns ?? [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.speaker === "hcp") {
      const rep = turns[i + 1]?.speaker === "rep" ? turns[i + 1]! : null;
      exchanges.push({ q: turns[i]!.text, a: rep?.text ?? "", sourceIds: rep?.sourceIds ?? [] });
    }
  }
  // A session is "real" (show video + click-through transcript) when it has any
  // real turns OR a recording — NOT only when there are paired HCP→rep exchanges.
  // A greeting-only video call (rep turn, no HCP turn yet) is still a real session.
  const real = !!detail && (detail.hasTurnDetail || !!detail.session.recordingUrl);

  const back = <div onClick={() => app.setNav("sessions")} style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "600 11.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer", marginBottom: 12 }}>‹ Back to Sessions</div>;
  const traceBox = (
    <div style={{ padding: 18, borderTop: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
      <div style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 4 }}>Turn-level decision path</div>
      <div style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 14 }}>Every turn passes this controlled graph before the HCP hears it.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {TRACE.map((n, i) => (
          <div key={i}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 8 }}>
              <span style={{ font: "700 9px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", background: "rgba(6,73,172,.08)", padding: "3px 6px", borderRadius: 5 }}>{i + 1}</span>
              <span style={{ font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{n}</span>
            </div>
            {i < TRACE.length - 1 && <div style={{ textAlign: "center", font: "400 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "2px 0" }}>↓</div>}
          </div>
        ))}
      </div>
    </div>
  );

  if (real && detail) {
    const s = detail.session;
    const sourcesCited = new Set(turns.filter((t) => t.speaker === "rep").flatMap((t) => t.sourceIds)).size;
    const gate = detail.audit.filter((a) => a.type === "compliance_decision");
    const approved = gate.filter((a) => a.payload.decision === "approved").length;
    const summary = [
      { label: "Turns", value: String(turns.length), color: "var(--dn-fg)" },
      { label: "Questions", value: String(s.questionCount), color: "var(--dn-fg)" },
      { label: "Gated outputs", value: `${approved}/${gate.length || exchanges.length}`, color: "var(--dn-success)" },
      { label: "Sources cited", value: String(sourcesCited), color: "var(--dn-brand-base)" },
      { label: "Compliance", value: COMP_LABEL[s.complianceStatus] ?? s.complianceStatus, color: "var(--dn-fg)" },
    ];
    // Align the timeline to session.startedAt. For recorded showcase sessions the local recorder
    // resequences startedAt to the MediaRecorder start, and each turn.at to the actual caption/audio
    // offset. That preserves a real pre-speech join gap instead of forcing the greeting to 00:00.
    // Replay timeline. Turn `at` timestamps are stamped at API-call time, so a burst of turns (a
    // deck walkthrough, or several Tavus replies logged back-to-back) collapses to the same second —
    // which made every line show ~00:18 and the slide jump to the last turn and freeze. Instead we
    // build a MONOTONIC timeline: each turn starts no earlier than the previous turn's estimated
    // speaking time, while a real pause (a larger `at` gap) is preserved. When a recording exists we
    // scale the whole timeline to its true length so the transcript + slide track the video.
    type Turn = (typeof turns)[number];
    const parsedSessionStart = Date.parse(s.startedAt);
    const startMs = Number.isFinite(parsedSessionStart)
      ? parsedSessionStart
      : turns[0]?.at ? Date.parse(turns[0]!.at!) : 0;
    const estDur = (t: Turn) => Math.min(32, Math.max(2.5, (t.text ?? "").trim().split(/\s+/).filter(Boolean).length * 0.42)); // ~140 wpm, clamped
    const recordedTimeline = s.timelineSource === "recorded";
    const rawOffsets: number[] = [];
    for (let i = 0; i < turns.length; i++) {
      const at = turns[i]!.at ? Math.max(0, (Date.parse(turns[i]!.at!) - startMs) / 1000) : 0;
      rawOffsets[i] = recordedTimeline
        ? Math.max(i === 0 ? 0 : rawOffsets[i - 1]!, at)
        : i === 0 ? 0 : Math.max(at, rawOffsets[i - 1]! + estDur(turns[i - 1]!));
    }
    const estTotal = (rawOffsets[turns.length - 1] ?? 0) + (turns.length ? estDur(turns[turns.length - 1]!) : 0);
    // Authoritative recording length: the client-reported MediaRecorder duration if we have it (set on
    // finalize), else the video element's resolved metadata. Used to tell an honest story when the
    // recording is shorter than the transcript.
    const recDurSec = s.recordingDurationMs && s.recordingDurationMs > 0 ? s.recordingDurationMs / 1000 : vidDur;
    const timelineDuration = recDurSec > 1 ? recDurSec : s.durationSeconds || 0;
    const recordingShort = !recordedTimeline && recDurSec > 1 && estTotal > recDurSec + 8;
    const scale = !recordedTimeline && timelineDuration > 1 && estTotal > 0 && !recordingShort ? timelineDuration / estTotal : 1;
    const offsets = rawOffsets.map((o) => o * scale);
    const offsetOf = (t: Turn) => { const i = turns.indexOf(t); return i >= 0 ? offsets[i]! : 0; };
    // Duration: the real recording length if known; else the recorded seconds; else the estimated
    // transcript span — so the header shows a real length, never "00:00" for a live/Tavus session.
    const effectiveDuration = Math.round(timelineDuration || estTotal);
    const seekTo = (off: number, i: number) => {
      setSel(i);
      const v = videoRef.current;
      const clickedTurn = turns[i];
      const seekAt = clickedTurn?.speaker === "rep" && clickedTurn.detailAidSlideId
        ? off + REVIEW_SLIDE_CUE_DELAY_SEC + 0.05
        : off;
      pendingSeekRef.current = seekAt;
      if (v) {
        try {
          v.currentTime = seekAt;
          const play = v.play?.();
          if (play && typeof play.catch === "function") void play.catch(() => {});
        } catch { /* noop */ }
      }
    };
    const selTurn = turns[Math.min(sel, turns.length - 1)]!;
    // The turn currently PLAYING (by video position); the detail-aid slide follows it
    // as the recording plays, and falls back to the clicked line when paused.
    const playIdx = turns.findIndex((t, i) => {
      const off = offsetOf(t);
      const next = i + 1 < turns.length ? offsetOf(turns[i + 1]!) : off + 3600;
      return nowSec >= off && nowSec < next;
    });
    const activeTurn = nowSec > 0.2 && playIdx >= 0 ? turns[playIdx]! : selTurn;
    // The detail-aid slide follows what the REP is presenting: it changes when the rep
    // starts answering, not the instant the HCP asks. A human keeps the current slide up
    // while the doctor is talking, then switches as they begin the answer — so we take the
    // slide the rep actually showed (turn.detailAidSlideId, resolved server-side) from the
    // most recent rep turn at/before the active line that had one; title before the first.
    const activeIdx = turns.indexOf(activeTurn);
    let slideId = "slide_title";
    for (let j = activeIdx; j >= 0; j--) {
      const turn = turns[j]!;
      const sid = turn.detailAidSlideId;
      if (turn.speaker === "rep" && sid) {
        const delayPassed = nowSec <= 0.2 || nowSec >= offsetOf(turn) + REVIEW_SLIDE_CUE_DELAY_SEC;
        if (delayPassed) { slideId = sid; break; }
      }
    }
    return (
      <div style={{ padding: "24px 30px 40px", maxWidth: 1400 }}>
        {back}
        <div style={eyebrow}>Session Detail · live record</div>
        <h1 style={{ ...h1, marginBottom: 6 }}>{s.hcp} — session review</h1>
        <p style={{ font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "0 0 12px" }}>{app.selectedSessionId} · {mmss(effectiveDuration)} · {detail.audit.length} audited events — every turn is a provable record.</p>
        {videoError && s.recordingUrl && (
          <div style={{ margin: "0 0 12px", padding: "9px 12px", border: "1px solid #f0a3a3", background: "#fdecec", borderRadius: 8, font: "600 11.5px/1.45 var(--dn-font-sans)", color: "#8a1f1f" }}>
            The recording for this session couldn&apos;t be loaded — the clip is likely truncated or corrupted, or it isn&apos;t on this server instance. The click-through transcript + audit below are the complete, provable record.
          </div>
        )}
        {!videoError && recordingShort && (
          <div style={{ margin: "0 0 12px", padding: "9px 12px", border: "1px solid #f3c969", background: "#fff8e6", borderRadius: 8, font: "600 11.5px/1.45 var(--dn-font-sans)", color: "#7a4b00" }}>
            The recording is {mmss(Math.round(recDurSec))} but the session ran to about {mmss(Math.round(estTotal))} — the video was switched off before the session ended, or the clip was cut short. Turns after {mmss(Math.round(recDurSec))} aren&apos;t in the video, but they&apos;re in the transcript + audit below.
          </div>
        )}
        {/* Compact stat strip (was a tall 5-card grid) — keeps the replay above the fold. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {summary.map((a) => (
            <span key={a.label} style={{ display: "inline-flex", alignItems: "baseline", gap: 6, padding: "6px 12px", background: "var(--dn-surface)", border: "1px solid var(--dn-border)", borderRadius: 20, font: "600 10.5px/1 var(--dn-font-sans)", letterSpacing: ".03em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>
              {a.label}<strong style={{ font: "700 12.5px/1 var(--dn-font-sans)", color: a.color }}>{a.value}</strong>
            </span>
          ))}
        </div>
        {/* Symmetric 2×2 replay — four equal blocks: recorded rep · approved slide (top row),
            turn evidence · click-through transcript (bottom row). Slides + transcript follow the
            recording timeline; click any line to jump the video. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: 300, gap: 16 }}>
          {/* 1 · recorded rep (in place of the live avatar) */}
          <div style={{ ...card, padding: 0, overflow: "hidden", background: "#0a1a33", display: "flex" }}>
            {s.recordingUrl ? (
              <video
                ref={videoRef}
                controls
                preload="metadata"
                src={s.recordingUrl}
                onTimeUpdate={(e) => setNowSec(e.currentTarget.currentTime)}
                onError={() => setVideoError(true)}
                onDurationChange={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) { setVidDur(d); setVideoError(false); } }}
                // MediaRecorder webm has no duration header (duration === Infinity), which
                // breaks the scrubber + click-to-seek; force a seek to the end so the browser
                // computes the real duration. If the user clicks a transcript row while this fix
                // is in flight, restore that requested seek instead of snapping back to 00:00.
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (!isFinite(v.duration) && !metadataFixingRef.current) {
                    metadataFixingRef.current = true;
                    const fix = () => {
                      v.removeEventListener("seeked", fix);
                      metadataFixingRef.current = false;
                      const restore = pendingSeekRef.current;
                      pendingSeekRef.current = null;
                      v.currentTime = restore ?? 0;
                    };
                    v.addEventListener("seeked", fix);
                    v.currentTime = 1e7;
                  }
                }}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000" }}
              />
            ) : (
              <div style={{ margin: "auto", padding: "0 20px", textAlign: "center", font: "400 12px/1.5 var(--dn-font-sans)", color: "#cfe0f6" }}>🎥 No video recording for this session — it was a text/voice session, or the video was never started. The click-through transcript + audit below are the full record.</div>
            )}
          </div>
          {/* 2 · approved slide the rep showed (follows the recording) */}
          <div style={{ ...card, padding: 14, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 8 }}>On screen now · follows the recording</div>
            <SlideView focusId={slideId} compact fill />
          </div>
          {/* 3 · turn evidence for the playing / selected line */}
          <div style={{ ...card, padding: "14px 16px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 2 }}>
              <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Turn evidence</span>
              {(() => {
                const sessionId = app.selectedSessionId;
                if (!sessionId) return null;
                return (
                  <span
                    data-testid="coach-exchange"
                    onClick={() => {
                      try { window.localStorage.setItem(TRAIN_SEED_KEY, JSON.stringify({ mode: "session", sessionId })); } catch { /* storage disabled — Training still opens */ }
                      app.setStudioMode("train");
                      app.setNav("studio");
                    }}
                    style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    ✎ Coach this session →
                  </span>
                );
              })()}
            </div>
            <div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 10 }}>{activeTurn.speaker === "hcp" ? "HCP" : "AI rep"} line at {mmss(Math.round(offsetOf(activeTurn)))}.</div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {([["Speaker", activeTurn.speaker === "hcp" ? "HCP" : "AI rep"], ["Said", activeTurn.text], ["Approved sources", activeTurn.sourceIds.length ? activeTurn.sourceIds.join(", ") : "None — routed / refused"], ["Compliance", COMP_LABEL[s.complianceStatus] ?? s.complianceStatus]] as [string, string][]).map(([l, v]) => (
                <div key={l} style={{ marginBottom: 10 }}>
                  <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 4 }}>{l}</div>
                  <div style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)", fontFamily: l === "Approved sources" ? "var(--dn-font-mono)" : undefined }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
          {/* 4 · click-through transcript */}
          <div style={{ ...card, padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", background: "var(--dn-surface-2)", borderBottom: "1px solid var(--dn-border)", font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", display: "flex", justifyContent: "space-between" }}>
              <span>Transcript</span><span>Click to jump</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {turns.map((t, i) => {
                const off = offsetOf(t);
                const next = i + 1 < turns.length ? offsetOf(turns[i + 1]!) : off + 3600;
                const playing = !!s.recordingUrl && nowSec >= off && nowSec < next;
                const isSel = sel === i;
                return (
                  <div key={`${t.at ?? ""}:${t.speaker}:${i}`} data-testid="session-transcript-turn" data-turn-index={i} onClick={() => seekTo(off, i)} style={{ display: "grid", gridTemplateColumns: "46px 1fr", gap: 10, padding: "9px 16px", borderBottom: "1px solid var(--dn-surface-2)", cursor: "pointer", background: isSel ? "rgba(6,73,172,.06)" : playing ? "var(--dn-surface-2)" : "transparent", borderLeft: `3px solid ${playing ? "var(--dn-brand-base)" : "transparent"}` }}>
                    <span style={{ fontFamily: "var(--dn-font-mono)", fontSize: 11, color: "var(--dn-brand-light)", paddingTop: 2 }}>{mmss(Math.round(off))}</span>
                    <span>
                      <span style={{ display: "block", font: "700 9px/1 var(--dn-font-sans)", letterSpacing: ".06em", textTransform: "uppercase", color: t.speaker === "hcp" ? "var(--dn-fg-subtle)" : "var(--dn-brand-base)", marginBottom: 3 }}>{t.speaker === "hcp" ? "HCP" : "AI rep"}</span>
                      <span style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{t.text}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", padding: "8px 0", listStyle: "none" }}>▸ Turn-level compliance path</summary>
          <div style={{ ...card, overflow: "hidden", marginTop: 8, maxWidth: 640 }}>{traceBox}</div>
        </details>
      </div>
    );
  }

  // Honest empty state — a session with no recorded turns yet. Never show fake
  // turns; direct the user to run a real conversation.
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1400 }}>
      {back}
      <div style={eyebrow}>Session Detail</div>
      <h1 style={{ ...h1, marginBottom: 6 }}>{detail?.session.hcp ?? "Session"} — session review</h1>
      <div style={{ ...card, padding: "26px 24px", maxWidth: 760, marginBottom: 14, font: "400 13px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>
        {loading
          ? "Loading the latest real session review..."
          : loadError || <>No recorded turns yet — start a conversation in <strong style={{ color: "var(--dn-fg)" }}>Preview HCP experience</strong>. Every turn logs here with its sources and compliance decision.</>}
      </div>
      <div style={{ ...card, overflow: "hidden", maxWidth: 760 }}>{traceBox}</div>
    </div>
  );
}

/* ===================== FOLLOW-UPS ===================== */
