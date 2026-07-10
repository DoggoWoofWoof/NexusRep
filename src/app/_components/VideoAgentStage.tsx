"use client";

/**
 * Renders the live video agent for the HCP view. Asks our server to open a
 * conversation (POST /api/realtime/conversation — vendor-neutral), then joins it
 * through a transport adapter (see video-transport.ts) and shows the agent's
 * video + audio. The agent's replies are produced by our compliance endpoint,
 * so nothing it says bypasses the gate. No vendor SDK or protocol lives here.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createVideoTransport, type VideoCallTransport } from "./video-transport";

type ConvResp = { provider: string; configured: boolean; conversationUrl: string | null; token: string | null; note: string; reachableLlm?: boolean; sessionId?: string };
type Stage = "loading" | "unconfigured" | "joining" | "live" | "ended" | "error";

/** Imperative handle so the HCP view can make the agent SPEAK a gated answer
 *  (verbatim, via the transport's echo) — used for typed turns while on video. */
export interface VideoAgentStageHandle {
  speak: (text: string) => void;
  /** Mute/unmute the AGENT's audio (what the doctor hears). */
  setMuted: (muted: boolean) => void;
  /** Enable/disable the doctor's own microphone on the call. */
  setMicEnabled: (on: boolean) => void;
}

type RepTurnNotice = { text: string; detailAidSlideId?: string | null; sourceIds?: string[] };

export const VideoAgentStage = forwardRef<VideoAgentStageHandle, { onClose: () => void; bare?: boolean; onRepTurn?: (turn: RepTurnNotice) => void; onHcpUtterance?: (text: string) => void; hcpId?: string; onMutedChange?: (muted: boolean) => void }>(function VideoAgentStage({ onClose, bare = false, onRepTurn, onHcpUtterance, hcpId, onMutedChange }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const transportRef = useRef<VideoCallTransport | null>(null);
  // The reviewable session this call logs into, + last-logged utterance for dedup.
  const sessionIdRef = useRef<string | null>(null);
  const convIdRef = useRef<string>("");
  const lastUtterRef = useRef<string>("");
  const onRepTurnRef = useRef<typeof onRepTurn>(onRepTurn);
  // When the vendor can reach our compliance endpoint, the server logs the authoritative
  // transcript (with detail-aid slideIds) and the client logs NOTHING (avoids doubling).
  // Only when it can't (localhost / no public URL) does the client log the spoken
  // utterances as a text-only fallback so the transcript isn't empty.
  const serverLogsRef = useRef(false);

  // Make the agent speak our (already gated) text verbatim, via the transport.
  const speakAgent = (text: string): boolean => transportRef.current?.speak(text) ?? false;
  const applyMuted = (m: boolean) => { setMuted(m); onMutedChange?.(m); };
  useImperativeHandle(ref, () => ({
    speak: (text: string) => { speakAgent(text); },
    setMuted: (m: boolean) => { applyMuted(m); },
    setMicEnabled: (on: boolean) => { setMicOn(on); transportRef.current?.setMicEnabled(on); },
  }));
  // Guards React StrictMode's double-invoke of effects in dev — without it the
  // component opens TWO vendor conversations (wasted minutes + a concurrent-slot clash).
  const startedRef = useRef(false);
  const [stage, setStage] = useState<Stage>("loading");
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);
  const [micOn, setMicOn] = useState(true);
  // join() resolves before the agent publishes media — keep the connecting status up
  // until the first real frame instead of showing an empty black pane.
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    onRepTurnRef.current = onRepTurn;
  }, [onRepTurn]);

  async function notifyAuthoritativeRepTurn(sessionId: string, utterance: string) {
    const notify = onRepTurnRef.current;
    if (!notify) return;
    let notice: RepTurnNotice = { text: utterance };
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        notify(notice);
        return;
      }
      const data = (await res.json()) as { turns?: RepTurnNotice[] };
      const reps = (data.turns ?? []).filter((t) => t && "text" in t);
      const normalized = utterance.replace(/\s+/g, " ").trim();
      const turn =
        [...reps].reverse().find((t) => t.text.replace(/\s+/g, " ").trim() === normalized) ??
        [...reps].reverse().find((t) => t.text);
      if (turn) notice = { ...turn, text: utterance };
    } catch {
      // Slide hydration is best-effort; the spoken caption is still useful to the UI.
    }
    notify(notice);
  }

  useEffect(() => {
    const w = window as unknown as { __nexusrepVideoAgent?: unknown };
    w.__nexusrepVideoAgent = { speak: speakAgent, getStage: () => stage, getNote: () => note };
    return () => {
      const current = (window as unknown as { __nexusrepVideoAgent?: unknown }).__nexusrepVideoAgent;
      if (current && (current as { speak?: unknown }).speak === speakAgent) {
        delete (window as unknown as { __nexusrepVideoAgent?: unknown }).__nexusrepVideoAgent;
      }
    };
  }, [note, stage]);

  useEffect(() => {
    // Start exactly once per mount (StrictMode invokes effects twice in dev).
    if (!startedRef.current) {
      startedRef.current = true;
      void (async () => {
      try {
        const res = await fetch("/api/realtime/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Invite-link identity — server honors it only for a real cohort member.
          body: JSON.stringify(hcpId ? { hcpId } : {}),
        });
        // The server always returns JSON — but an OOM/502 or gateway error yields an
        // HTML error page. Parse defensively so we show a clean note instead of crashing
        // with "Unexpected token '<'", and fall back to the built-in avatar.
        const raw = await res.text();
        let d: ConvResp;
        try {
          d = JSON.parse(raw) as ConvResp;
        } catch {
          setNote(`Couldn't start the video rep: the service returned an error (HTTP ${res.status}). It may be out of memory or restarting — the built-in avatar still works.`);
          setStage("unconfigured");
          return;
        }
        if (!d.configured || !d.conversationUrl) {
          setNote(d.note);
          setStage("unconfigured");
          return;
        }
        sessionIdRef.current = d.sessionId ?? null;
        convIdRef.current = (() => { try { return new URL(d.conversationUrl!).pathname.split("/").filter(Boolean).pop() || ""; } catch { return ""; } })();
        // Expose ids for automation/QA (the record bot reads these to attach the
        // recording to the right session). Harmless in normal use.
        (window as unknown as { __nexusrep?: unknown }).__nexusrep = { sessionId: d.sessionId ?? null, conversationUrl: d.conversationUrl };
        if (d.reachableLlm === false) setNote(d.note);
        // Reachable → the server's compliance endpoint is the transcript source of truth.
        serverLogsRef.current = d.reachableLlm === true;
        setStage("joining");

        const transport = createVideoTransport(d.provider, { conversationUrl: d.conversationUrl, token: d.token });
        if (!transport) {
          setNote(`No client transport for the "${d.provider}" provider — the built-in avatar still works.`);
          setStage("unconfigured");
          return;
        }
        transportRef.current = transport;

        // Bare/record mode: capture ONLY the agent stream (video+audio) starting at
        // the FIRST live frame — trims the connect boot and excludes all page chrome.
        // Exposes window.__nexusrepRec.stop() → base64 webm for the recorder.
        let recStarted = false;
        const maybeStartRec = () => {
          // Record when in bare mode OR when a recorder set window.__nexusrepRecord
          // (used to capture an agent-only clip of a full multi-turn doctor session).
          const recWanted = bare || (window as unknown as { __nexusrepRecord?: boolean }).__nexusrepRecord === true;
          if (!recWanted || recStarted || typeof MediaRecorder === "undefined") return;
          const vs = videoRef.current?.srcObject as MediaStream | null;
          const as = audioRef.current?.srcObject as MediaStream | null;
          const tracks = [...(vs?.getVideoTracks() ?? []), ...(as?.getAudioTracks() ?? [])];
          if (!tracks.some((t) => t.kind === "video")) return; // wait for the video track
          recStarted = true;
          try {
            const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
            const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime });
            const chunks: BlobPart[] = [];
            rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            rec.start(1000);
            (window as unknown as { __nexusrepRec?: unknown }).__nexusrepRec = {
              mimeType: mime,
              stop: () =>
                new Promise<string>((resolve) => {
                  let settled = false;
                  const finish = async () => {
                    if (settled) return;
                    settled = true;
                    const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
                    let bin = "";
                    const CH = 0x8000;
                    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
                    resolve(btoa(bin));
                  };
                  rec.onstop = () => { void finish(); };
                  setTimeout(() => { void finish(); }, 4000);
                  try {
                    if (rec.state !== "inactive") rec.requestData();
                    if (rec.state !== "inactive") rec.stop();
                    else void finish();
                  } catch {
                    void finish();
                  }
                }),
            };
          } catch { recStarted = false; }
        };

        await transport.join({
          onTrack: (kind, stream) => {
            if (kind === "video" && videoRef.current) {
              videoRef.current.srcObject = stream;
              void videoRef.current.play?.();
              setHasVideo(true);
              // A dying track (vendor shutdown, network) must not leave a frozen black
              // frame — drop back to the status area, which explains what happened.
              const track = stream.getVideoTracks()[0];
              if (track) track.onended = () => setHasVideo(false);
            }
            if (kind === "audio" && audioRef.current) { audioRef.current.srcObject = stream; void audioRef.current.play?.(); }
            // Fallback: if the agent never emits an utterance event, still start recording a few
            // seconds after the video track arrives so we never miss a clip. The PRIMARY start is
            // on the agent's first spoken words (see onUtterance) — that trims the connect boot.
            if (kind === "video") setTimeout(maybeStartRec, 6000);
          },
          onRawEvent: (e) => {
            // QA aid: record ALL conversation events so tests can see what the agent
            // does after an echo (started/stopped speaking, utterances). Harmless.
            const w = window as unknown as { __nexusrepEvents?: { type: string; role: string; text: string }[] };
            w.__nexusrepEvents = [...(w.__nexusrepEvents ?? []).slice(-40), e];
            // The vendor ended the call (credits exhausted, duration cap, account limit).
            // Without this the pane just froze to black with no explanation.
            if (/shutdown|call_ended|conversation.ended/i.test(e.type)) {
              setHasVideo(false);
              setNote("The video call was ended by the provider — this usually means the account is out of conversational credits or hit a limit. Close the video and try again once that's resolved.");
              setStage("ended");
            }
          },
          onUtterance: ({ speaker, text }) => {
            // ASR silence/noise artifacts are not speech — never caption or log them.
            if (/^\s*[[(]\s*(?:blank[_ ]?audio|inaudible|silence|no[_ ]?speech|noise|music|applause|laughter)\s*[\])]\s*$/i.test(text)) return;
            // Begin the recording at the agent's FIRST words (the greeting) so the clip trims
            // the connect boot + any idle before the rep speaks. No-op once already recording.
            if (speaker === "rep") maybeStartRec();
            // The doctor's SPOKEN words must appear in the captions like typed ones do —
            // without this, a voice-only conversation has no "You" lines at all.
            if (speaker === "hcp") onHcpUtterance?.(text);
            const sid = sessionIdRef.current;
            if (!sid) return;
            const key = `${speaker}:${text}`;
            if (key === lastUtterRef.current) return; // client-side dedup of re-emits
            lastUtterRef.current = key;
            // Only log from the client when the server can't (unreachable compliance endpoint).
            // When reachable, the server already logged this turn with its slideId.
            if (serverLogsRef.current) {
              if (speaker === "rep") void notifyAuthoritativeRepTurn(sid, text);
              return;
            }
            void fetch("/api/sessions/utterance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: sid, speaker, text }),
            });
          },
        });
        setStage("live");
        maybeStartRec(); // in case the video track already arrived before join resolved
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
        setStage("error");
      }
      })();
    }
    return () => {
      transportRef.current?.leave();
      transportRef.current = null;
      // Leaving the room does NOT end the vendor conversation — it lingers and holds a
      // concurrent-session slot until the vendor times it out. End it explicitly so repeated
      // previews don't pile up to the account cap. keepalive: survives the unmount/navigation.
      const cid = convIdRef.current;
      if (cid) {
        try {
          void fetch("/api/realtime/conversation/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: cid }),
            keepalive: true,
          });
        } catch { /* best-effort */ }
      }
      convIdRef.current = "";
    };
  }, []);

  // Bare mode: JUST the agent video, full-bleed, no captions/overlays/chrome —
  // used to capture a clean recording of only the rep (the recorder navigates to
  // /hcp?bare=1). Everything else (transcript logging, session wiring) is unchanged.
  const container: React.CSSProperties = bare
    ? { position: "fixed", inset: 0, background: "#0a1a33", display: "flex", alignItems: "center", justifyContent: "center" }
    : { position: "relative", borderRadius: "var(--dn-radius-lg)", overflow: "hidden", background: "#0a1a33", aspectRatio: "4 / 3", display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={container}>
      <video ref={videoRef} autoPlay playsInline muted={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: stage === "live" && hasVideo ? "block" : "none" }} />
      <audio ref={audioRef} autoPlay muted={muted} />
      {(stage !== "live" || !hasVideo) && (
        <div style={{ color: "#cfe0f6", textAlign: "center", padding: 20, fontSize: 13, maxWidth: 420 }}>
          {stage === "loading" && "Starting the video rep…"}
          {stage === "joining" && "Connecting to the DocNexus Agent…"}
          {stage === "live" && !hasVideo && "The agent is joining — video starts in a few seconds…"}
          {(stage === "unconfigured" || stage === "ended") && note}
          {stage === "error" && `Couldn't start the video rep: ${note}`}
        </div>
      )}
      {!bare && stage === "live" && note && (
        <div style={{ position: "absolute", top: 8, left: 8, right: 8, background: "rgba(180,83,9,.9)", color: "#fff", fontSize: 11, padding: "5px 9px", borderRadius: 7 }}>{note}</div>
      )}
      {!bare && (
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 6 }}>
          {/* No overlay controls on the pane besides End video: agent audio is the header
              Sound button, and your microphone is the ask-bar mic button (both proxy to
              the stage handle). */}
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", color: "#fff", border: "1px solid rgba(255,255,255,.3)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>End video</button>
        </div>
      )}
    </div>
  );
});
