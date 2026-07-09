"use client";

/**
 * Renders the live Tavus replica for the HCP view. Asks our server to open a CVI
 * conversation (POST /api/tavus/conversation), then joins the returned Daily/WebRTC
 * room with the Daily SDK and shows the replica's video + audio and live captions.
 * The replica's replies are produced by our compliance endpoint (see the route),
 * so nothing it says bypasses the gate. Daily is imported lazily (browser only).
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

type ConvResp = { provider: string; configured: boolean; conversationUrl: string | null; token: string | null; note: string; reachableLlm?: boolean; sessionId?: string };
type Stage = "loading" | "unconfigured" | "joining" | "live" | "error";
type CallObj = { leave: () => void; destroy: () => void; sendAppMessage: (data: unknown, to?: string) => void };

/** Imperative handle so the HCP view can make the replica SPEAK a gated answer
 *  (verbatim, via Tavus's echo interaction) — used for typed turns while on video. */
export interface TavusStageHandle {
  speak: (text: string) => void;
}

export const TavusStage = forwardRef<TavusStageHandle, { onClose: () => void; bare?: boolean }>(function TavusStage({ onClose, bare = false }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const callRef = useRef<CallObj | null>(null);
  // The reviewable session this call logs into, + last-logged utterance for dedup.
  const sessionIdRef = useRef<string | null>(null);
  const convIdRef = useRef<string>("");
  const lastUtterRef = useRef<string>("");

  // Make the replica speak our (already gated) text verbatim. Tavus "echo"
  // interaction over the Daily data channel; we interrupt any current speech
  // first so typed answers don't queue behind the greeting.
  const speakReplica = (text: string): boolean => {
    const call = callRef.current;
    const cid = convIdRef.current;
    const t = (text || "").trim();
    if (!call || !t) return false;
    const echo = () => {
      try { call.sendAppMessage({ message_type: "conversation", event_type: "conversation.echo", conversation_id: cid, properties: { text: t } }, "*"); } catch { /* not connected */ }
    };
    try {
      // Gently stop any in-progress speech, then a short natural beat before the new
      // answer — so a barge-in doesn't jump-cut mid-word (it reads like a person
      // pausing to pick up the new question rather than an abrupt splice).
      call.sendAppMessage({ message_type: "conversation", event_type: "conversation.interrupt", conversation_id: cid }, "*");
      setTimeout(echo, 220);
    } catch { echo(); }
    return true;
  };
  useImperativeHandle(ref, () => ({ speak: (text: string) => { speakReplica(text); } }), []);
  // Guards React StrictMode's double-invoke of effects in dev — without it the
  // component opens TWO Tavus conversations (wasted minutes + a concurrent-slot clash).
  const startedRef = useRef(false);
  const [stage, setStage] = useState<Stage>("loading");
  const [note, setNote] = useState("");
  const [caption, setCaption] = useState("");

  useEffect(() => {
    const w = window as unknown as { __nexusrepTavus?: unknown };
    w.__nexusrepTavus = { speak: speakReplica, getStage: () => stage, getNote: () => note };
    return () => {
      const current = (window as unknown as { __nexusrepTavus?: unknown }).__nexusrepTavus;
      if (current && (current as { speak?: unknown }).speak === speakReplica) {
        delete (window as unknown as { __nexusrepTavus?: unknown }).__nexusrepTavus;
      }
    };
  }, [note, stage]);

  useEffect(() => {
    // Start exactly once per mount (StrictMode invokes effects twice in dev).
    if (!startedRef.current) {
      startedRef.current = true;
      void (async () => {
      try {
        const res = await fetch("/api/tavus/conversation", { method: "POST" });
        const d = (await res.json()) as ConvResp;
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
        setStage("joining");
        const Daily = (await import("@daily-co/daily-js")).default;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const call: any = Daily.createCallObject({ audioSource: true, videoSource: false });
        callRef.current = call;

        // Bare/record mode: capture ONLY the replica stream (video+audio) starting at
        // the FIRST live frame — trims the ~20s "Connecting" boot and excludes all page
        // chrome. Exposes window.__nexusrepRec.stop() → base64 webm for the recorder.
        let recStarted = false;
        const maybeStartRec = () => {
          // Record when in bare mode OR when a recorder set window.__nexusrepRecord
          // (used to capture a replica-only clip of a full multi-turn doctor session).
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        call.on("track-started", (ev: any) => {
          if (ev?.participant?.local || !ev?.track) return;
          const stream = new MediaStream([ev.track]);
          if (ev.track.kind === "video" && videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play?.(); }
          if (ev.track.kind === "audio" && audioRef.current) { audioRef.current.srcObject = stream; void audioRef.current.play?.(); }
          // Start recording shortly after the video track arrives (give audio a beat).
          if (ev.track.kind === "video") setTimeout(maybeStartRec, 700);
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        call.on("app-message", (ev: any) => {
          const p = ev?.data;
          // QA aid: record ALL conversation events so tests can see what the replica
          // does after an echo (started/stopped speaking, utterances). Harmless.
          {
            const w = window as unknown as { __nexusrepEvents?: { type: string; role: string; text: string }[] };
            w.__nexusrepEvents = [...(w.__nexusrepEvents ?? []).slice(-40), { type: String(p?.event_type ?? ""), role: String(p?.properties?.role ?? ""), text: String(p?.properties?.speech ?? p?.properties?.text ?? "").slice(0, 80) }];
          }
          if (p?.event_type !== "conversation.utterance") return;
          const props = p?.properties ?? {};
          const utter = String(props.speech ?? props.text ?? "").trim();
          if (!utter) return;
          setCaption(utter);
          // Log BOTH sides into the call's session (the transcript source of truth).
          const role = String(props.role ?? "").toLowerCase();
          const speaker = role.includes("replica") ? "rep" : role.includes("user") ? "hcp" : null;
          const sid = sessionIdRef.current;
          if (!speaker || !sid) return;
          const key = `${speaker}:${utter}`;
          if (key === lastUtterRef.current) return; // client-side dedup of re-emits
          lastUtterRef.current = key;
          void fetch("/api/sessions/utterance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sid, speaker, text: utter }),
          });
        });
        await call.join({ url: d.conversationUrl, ...(d.token ? { token: d.token } : {}) });
        setStage("live");
        maybeStartRec(); // in case the video track already arrived before join resolved
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
        setStage("error");
      }
      })();
    }
    return () => {
      const c = callRef.current;
      if (c) { try { c.leave(); c.destroy(); } catch { /* noop */ } }
      callRef.current = null;
    };
  }, []);

  // Bare mode: JUST the replica video, full-bleed, no captions/overlays/chrome —
  // used to capture a clean recording of only the rep (the recorder navigates to
  // /hcp?bare=1). Everything else (transcript logging, session wiring) is unchanged.
  const container: React.CSSProperties = bare
    ? { position: "fixed", inset: 0, background: "#0a1a33", display: "flex", alignItems: "center", justifyContent: "center" }
    : { position: "relative", borderRadius: "var(--dn-radius-lg)", overflow: "hidden", background: "#0a1a33", aspectRatio: "4 / 3", display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={container}>
      <video ref={videoRef} autoPlay playsInline muted={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: stage === "live" ? "block" : "none" }} />
      <audio ref={audioRef} autoPlay />
      {stage !== "live" && (
        <div style={{ color: "#cfe0f6", textAlign: "center", padding: 20, fontSize: 13, maxWidth: 420 }}>
          {stage === "loading" && "Starting the video rep…"}
          {stage === "joining" && "Connecting to the Tavus replica…"}
          {stage === "unconfigured" && note}
          {stage === "error" && `Couldn't start the video rep: ${note}`}
        </div>
      )}
      {!bare && stage === "live" && caption && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, textAlign: "center", padding: "0 16px" }}>
          <span style={{ background: "rgba(0,0,0,.55)", color: "#fff", padding: "6px 12px", borderRadius: 8, fontSize: 13, lineHeight: 1.4 }}>{caption}</span>
        </div>
      )}
      {!bare && stage === "live" && note && (
        <div style={{ position: "absolute", top: 8, left: 8, right: 8, background: "rgba(180,83,9,.9)", color: "#fff", fontSize: 11, padding: "5px 9px", borderRadius: 7 }}>{note}</div>
      )}
      {!bare && (
        <button onClick={onClose} style={{ position: "absolute", top: 8, right: 8, background: "rgba(255,255,255,.15)", color: "#fff", border: "1px solid rgba(255,255,255,.3)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>End video</button>
      )}
    </div>
  );
});
