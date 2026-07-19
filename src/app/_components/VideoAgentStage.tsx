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
import { estimateReplicaSpeechMs, isHcpRawEvent, isRepRawEvent } from "./video-events";

type ConvResp = { provider: string; configured: boolean; conversationUrl: string | null; token: string | null; note: string; reachableLlm?: boolean; sessionId?: string; greeting?: string | null };
type Stage = "loading" | "unconfigured" | "joining" | "live" | "ended" | "error";
type TimingEvent = {
  type: string;
  at: number;
  reason?: string;
  delayMs?: number;
  text?: string;
  detailAidSlideId?: string | null;
  captionKind?: PendingRepEcho["kind"];
  audioStarted?: boolean;
  level?: number;
  role?: string;
};

/** Imperative handle so platform-controlled scripted segments can make the agent
 *  speak gated text verbatim via transport echo. Normal HCP typed turns use
 *  `respond()` so Tavus runs the same custom-LLM path as microphone input. */
export interface VideoAgentStageHandle {
  speak: (text: string, detailAidSlideId?: string | null) => boolean;
  respond: (text: string) => boolean;
  /** Echo one gated segment and resolve when the replica finishes it (event-driven pacing, with a
   *  hard cap so it never hangs). For callers that drive their own deck/transcript (the Studio
   *  rehearsal) and just need robust one-after-another pacing. bargeIn interrupts what's in progress. */
  speakAndWait: (text: string, detailAidSlideId?: string | null, bargeIn?: boolean) => Promise<void>;
  /** Mute/unmute the AGENT's audio (what the doctor hears). */
  setMuted: (muted: boolean) => void;
  /** Enable/disable the doctor's own microphone on the call. */
  setMicEnabled: (on: boolean) => void;
  /** Stop the client-side recording and upload it to the session (idempotent). Awaited by the
   *  "end session" flows so the replica clip is attached before the call tears down. No-op unless
   *  recordSession captured a clip. */
  finalizeRecording: () => Promise<void>;
}

type RepTurnNotice = { text: string; detailAidSlideId?: string | null; sourceIds?: string[] };
type SessionTurnNotice = RepTurnNotice & { speaker?: "hcp" | "rep" };
type PendingRepEcho = { text: string; detailAidSlideId?: string | null; timer?: number; notified: boolean; queuedAt: number; kind: "greeting" | "answer" };
type VideoSessionNotice = { sessionId: string | null; conversationUrl: string | null };
type VideoAgentStageProps = {
  onClose: () => void;
  bare?: boolean;
  onRepTurn?: (turn: RepTurnNotice) => void;
  onHcpUtterance?: (text: string) => void;
  normalizeHcpUtterance?: (text: string) => string;
  hcpId?: string;
  onMutedChange?: (muted: boolean) => void;
  onRepAudioStart?: () => void;
  onHcpSpeechStart?: () => void;
  onMicReadyChange?: (ready: boolean) => void;
  onDoctorMicActiveChange?: (active: boolean) => void;
  onSessionReady?: (session: VideoSessionNotice | null) => void;
  /** Record the replica clip during a normal doctor session and upload it on end (Tavus's own
   *  recording is off on our account, so we capture it ourselves). Independent of bare/bot mode. */
  recordSession?: boolean;
};

export const VideoAgentStage = forwardRef<VideoAgentStageHandle, VideoAgentStageProps>(function VideoAgentStage({ onClose, bare = false, onRepTurn, onHcpUtterance, normalizeHcpUtterance, hcpId, onMutedChange, onRepAudioStart, onHcpSpeechStart, onMicReadyChange, onDoctorMicActiveChange, onSessionReady, recordSession = false }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const transportRef = useRef<VideoCallTransport | null>(null);
  // The reviewable session this call logs into, + last-logged utterance for dedup.
  const sessionIdRef = useRef<string | null>(null);
  const convIdRef = useRef<string>("");
  const lastUtterRef = useRef<string>("");
  // Client-side session recording: the live recorder's chunks/mime + a stop fn, so the "end session"
  // flow can stop it and upload the replica clip. recordSession is read via a ref so the (run-once)
  // join effect sees the current value. recordingDoneRef makes finalizeRecording idempotent.
  const recorderRef = useRef<{ stop: () => void; chunks: BlobPart[]; mime: string } | null>(null);
  const recordingDoneRef = useRef(false);
  // Streaming-upload state: chunks are POSTed to /api/sessions/recording/chunk AS the call happens, in
  // seq order, so a clean end only flushes the last chunk (fast) and an abrupt close still leaves
  // everything up to the last chunk on the server. `uploaded` = how many chunks have landed; `chain`
  // serializes uploads so the server appends them in order (chunk 0 carries the WebM header).
  const recStreamRef = useRef<{ active: boolean; mime: string; startedAt: number; uploaded: number; chain: Promise<void> }>(
    { active: false, mime: "", startedAt: 0, uploaded: 0, chain: Promise.resolve() },
  );
  const recordSessionRef = useRef(recordSession);
  const onRepTurnRef = useRef<typeof onRepTurn>(onRepTurn);
  // Fires when the replica's AUDIO starts (vendor_started_speaking), so the parent anchors the
  // detail-aid slide switch to when the rep actually begins speaking — then times the cue offset
  // from there. (The streaming TEXT is NOT used to switch: with a custom LLM it arrives well before
  // it's spoken, which switched the deck far too early.)
  const onRepAudioStartRef = useRef<typeof onRepAudioStart>(onRepAudioStart);
  const onHcpSpeechStartRef = useRef<typeof onHcpSpeechStart>(onHcpSpeechStart);
  const onMicReadyChangeRef = useRef<typeof onMicReadyChange>(onMicReadyChange);
  const onDoctorMicActiveChangeRef = useRef<typeof onDoctorMicActiveChange>(onDoctorMicActiveChange);
  const onSessionReadyRef = useRef<typeof onSessionReady>(onSessionReady);
  const normalizeHcpUtteranceRef = useRef<typeof normalizeHcpUtterance>(normalizeHcpUtterance);
  // The opening line we speak as a normal (interruptible) echo once the replica is live — instead
  // of Tavus's custom_greeting, which is always non-interruptible. Echoed exactly once.
  const greetingRef = useRef<string | null>(null);
  const greetedRef = useRef(false);
  // When the vendor can reach our compliance endpoint, the server logs the authoritative
  // transcript (with detail-aid slideIds) and the client logs NOTHING (avoids doubling).
  // Only when it can't (localhost / no public URL) does the client log the spoken
  // utterances as a text-only fallback so the transcript isn't empty.
  const serverLogsRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioMeterDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const audioMeterStreamRef = useRef<MediaStream | null>(null);
  // Client-side echo turns (typed asks while video is on) may not always be echoed back as a
  // Tavus finalized utterance. Keep the pending gated text here so the transcript can still be
  // written when the replica starts speaking, with the slide id already known.
  const pendingRepEchoRef = useRef<PendingRepEcho | null>(null);
  const desiredMicOnRef = useRef(false);
  const micReadyRef = useRef(false);
  const doctorMicActiveRef = useRef(false);
  const remoteVideoReadyRef = useRef(false);
  const remoteAudioReadyRef = useRef(false);
  const greetingTimerRef = useRef<number | null>(null);
  // True while the replica is currently producing audio (between started/stopped-speaking).
  // A caption armed while this is true is released at once (the voice is already out); one armed
  // before it flips releases when speaking starts — so the caption lands WITH the voice, either order.
  const repSpeakingRef = useRef(false);
  // The doctor question (hcp_final_utterance.at) whose latency we've already reported, so each turn
  // logs its ASR/think breakdown exactly once when the replica starts speaking.
  const lastLatencyTurnRef = useRef(0);
  const repStopFallbackRef = useRef<number | null>(null);
  const repLikelySpeakingUntilRef = useRef(0);
  const typedRespondRef = useRef<{ text: string; at: number } | null>(null);
  const startNonceRef = useRef("");
  const startupRunRef = useRef(0);
  const deferredCleanupRef = useRef<number | null>(null);
  if (!startNonceRef.current) {
    startNonceRef.current = globalThis.crypto?.randomUUID?.() ?? `video_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  // Make the agent speak our (already gated) text verbatim, via the transport. bargeIn defaults to
  // true (a typed ask cuts in over any in-progress speech); the guided-overview walk passes false for
  // each paced segment so one segment doesn't interrupt the tail of the previous.
  const speakAgent = (text: string, detailAidSlideId?: string | null, bargeIn = true): boolean => {
    const t = text.trim();
    if (!t) return false;
    const ok = transportRef.current?.speak(t, bargeIn) ?? false;
    if (!ok) return false;
    recordTiming({ type: "echo_queued", text: t, detailAidSlideId: detailAidSlideId ?? null });
    armRepCaption({ text: t, detailAidSlideId: detailAidSlideId ?? null, kind: "answer" });
    return true;
  };

  // Segment pacing (speakAndWait): resolvers waiting for the replica to FINISH the segment it's
  // speaking, so a caller can echo the next one only after the current lands (event-driven, not a
  // guess). markRepAudioStart flags them "started"; markRepAudioStop (or the estimated-end fallback)
  // resolves them. A per-call hard cap in speakSegmentAndWait guarantees it never hangs if events go missing.
  const repDoneWaitersRef = useRef<{ started: boolean; done: () => void }[]>([]);
  const flushRepDoneWaiters = () => {
    const waiters = repDoneWaitersRef.current;
    repDoneWaitersRef.current = waiters.filter((w) => !w.started);
    waiters.filter((w) => w.started).forEach((w) => w.done());
  };
  // Echo one gated segment and resolve when the replica finishes it. bargeIn defaults to false (a
  // paced segment shouldn't cut the tail of the previous); the first segment of a walk passes true
  // to interrupt whatever was in progress (e.g. the greeting).
  const speakSegmentAndWait = (text: string, detailAidSlideId?: string | null, bargeIn = false): Promise<void> =>
    new Promise<void>((resolve) => {
      const ok = speakAgent(text, detailAidSlideId, bargeIn);
      if (!ok) { resolve(); return; }
      let settled = false;
      const finish = () => { if (settled) return; settled = true; window.clearTimeout(cap); resolve(); };
      const cap = window.setTimeout(() => {
        repDoneWaitersRef.current = repDoneWaitersRef.current.filter((w) => w !== waiter);
        finish();
      }, estimateReplicaSpeechMs(text) + 3_000);
      const waiter = { started: false, done: finish };
      repDoneWaitersRef.current.push(waiter);
    });
  const applyMuted = (m: boolean) => { setMuted(m); onMutedChange?.(m); };
  // Stop the client-side replica recording and upload it to this session, then attach it. Idempotent
  // (the "End video" button AND the parent's end-session flow may both call it). We record the clip
  // ourselves because Tavus's own recording is off on this account — see /api/sessions/recording.
  // Upload any chunks not yet sent, in seq order (chunk 0 first — it carries the WebM header). Safe to
  // call repeatedly (on every dataavailable and on finalize); serialized via recStreamRef.chain. A
  // failed chunk doesn't advance `uploaded`, so the next pump retries it.
  const pumpRecordingUploads = (): void => {
    const s = recStreamRef.current;
    const sid = sessionIdRef.current;
    if (!s.active || !sid || !s.mime) return; // sid not ready yet → chunks stay buffered, pumped next time
    s.chain = s.chain.then(async () => {
      const all = recorderRef.current?.chunks ?? [];
      while (s.uploaded < all.length) {
        const idx = s.uploaded;
        try {
          const res = await fetch("/api/sessions/recording/chunk", {
            method: "POST",
            headers: { "Content-Type": s.mime, "x-nexusrep-session-id": sid, "x-nexusrep-chunk-seq": String(idx) },
            body: all[idx] as Blob,
          });
          if (!res.ok) return; // retry this seq on the next pump
          s.uploaded = idx + 1;
        } catch {
          return; // network hiccup — retry on the next pump; never skip a chunk (would corrupt the WebM)
        }
      }
    });
  };

  // Stop the client-side replica recording and attach it to this session. Idempotent ("End video" AND
  // the parent's end-session flow may both call it). Streaming path (interactive doctor session): the
  // chunks already streamed as the call ran, so we only flush the final chunk + a finalize marker
  // (duration) — fast, within a few hundred ms. Fallback path (bare/script capture, or if streaming
  // never started): the original whole-blob upload.
  const finalizeRecording = async (): Promise<void> => {
    if (recordingDoneRef.current) return;
    const r = recorderRef.current;
    const sid = sessionIdRef.current;
    if (!r || !sid) return;
    recordingDoneRef.current = true;
    const s = recStreamRef.current;
    try {
      r.stop(); // flushes the final dataavailable into r.chunks
      if (s.active) {
        await new Promise((resolve) => window.setTimeout(resolve, 250)); // let the final chunk land in r.chunks
        pumpRecordingUploads();
        await s.chain; // drain remaining chunks — fast, since all but the last already streamed
        // Finalize marker (empty body) → server sets the duration + logs completion. If this never
        // arrives (abrupt close), the URL was already attached on chunk 0, so the recording still shows.
        await fetch("/api/sessions/recording/chunk", {
          method: "POST",
          headers: {
            "Content-Type": s.mime,
            "x-nexusrep-session-id": sid,
            "x-nexusrep-chunk-seq": String(s.uploaded),
            "x-nexusrep-final": "1",
            "x-nexusrep-duration-ms": String(Math.max(0, Date.now() - s.startedAt)),
          },
          body: new Blob([], { type: s.mime }),
          keepalive: true, // empty marker is tiny → survives an unmount
        });
        recordTiming({ type: "recording_finalized", reason: `streamed_${s.uploaded}_chunks` });
        return;
      }
      // Fallback: whole-blob upload (bare/script capture or streaming disabled).
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      const blob = new Blob(r.chunks, { type: r.mime });
      if (!blob.size) { recordingDoneRef.current = false; return; }
      const res = await fetch("/api/sessions/recording", {
        method: "POST",
        headers: { "Content-Type": r.mime, "x-nexusrep-session-id": sid },
        body: blob,
      });
      recordTiming({ type: "recording_uploaded", reason: res.ok ? `${blob.size}B` : `http_${res.status}` });
    } catch {
      recordingDoneRef.current = false; // let a later end trigger retry
    }
  };
  // End the Tavus conversation IMMEDIATELY on the deliberate "End video" click — the explicit end
  // signal, so the slot frees at once rather than after the 750ms deferred-unmount backstop. The
  // unmount teardown still calls this (keepalive) as a silent backstop for tab-close / nav-away; a
  // second end on an already-ended conversation is a harmless best-effort no-op.
  const endConversationNow = () => {
    const cid = convIdRef.current;
    if (!cid) return;
    try {
      void fetch("/api/realtime/conversation/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: cid, reason: "ended_by_doctor" }), // deliberate End click
        keepalive: true,
      });
    } catch { /* best-effort */ }
    recordTiming({ type: "conversation_end_explicit", reason: cid });
  };
  useImperativeHandle(ref, () => ({
    speak: (text: string, detailAidSlideId?: string | null) => speakAgent(text, detailAidSlideId),
    speakAndWait: (text: string, detailAidSlideId?: string | null, bargeIn = false) => speakSegmentAndWait(text, detailAidSlideId, bargeIn),
    finalizeRecording,
    respond: (text: string) => {
      // A typed/scripted video turn should prevent the scheduled greeting from firing after the
      // doctor has already asked something. If the greeting is merely pending, cancel it locally;
      // if the replica is already speaking, shouldInterruptDoctorInput() below will still interrupt.
      cancelPendingGreeting("typed_respond");
      const interrupt = shouldInterruptDoctorInput();
      const ok = transportRef.current?.respond(text, interrupt) ?? false;
      if (ok) {
        typedRespondRef.current = { text: text.replace(/\s+/g, " ").trim(), at: Date.now() };
        if (interrupt) cancelCurrentRepForBargeIn("typed_barge_in");
        recordTiming({ type: "typed_respond_sent", text, reason: interrupt ? "barge_in" : "idle" });
      }
      return ok;
    },
    setMuted: (m: boolean) => { applyMuted(m); },
    setMicEnabled: (on: boolean) => {
      desiredMicOnRef.current = on;
      if (!on) setDoctorMicActive(false, "requested_off");
      if (micReadyRef.current) {
        const active = transportRef.current?.setMicEnabled(on) ?? false;
        if (on && active) setDoctorMicActive(true, "set_local_audio_returned_true");
      }
      recordTiming({ type: "doctor_mic_toggled", reason: on ? "on" : "off" });
    },
  }));
  const [stage, setStage] = useState<Stage>("loading");
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);
  // join() resolves before the agent publishes media — keep the connecting status up
  // until the first real frame instead of showing an empty black pane.
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    onRepTurnRef.current = onRepTurn;
    onRepAudioStartRef.current = onRepAudioStart;
    onHcpSpeechStartRef.current = onHcpSpeechStart;
    onMicReadyChangeRef.current = onMicReadyChange;
    onDoctorMicActiveChangeRef.current = onDoctorMicActiveChange;
    onSessionReadyRef.current = onSessionReady;
    normalizeHcpUtteranceRef.current = normalizeHcpUtterance;
    recordSessionRef.current = recordSession;
  }, [onRepTurn, onRepAudioStart, onHcpSpeechStart, onMicReadyChange, onDoctorMicActiveChange, onSessionReady, normalizeHcpUtterance, recordSession]);

  function setDoctorMicActive(active: boolean, reason: string) {
    if (doctorMicActiveRef.current === active) return;
    doctorMicActiveRef.current = active;
    recordTiming({ type: "doctor_mic_active", reason: active ? reason : `inactive_${reason}` });
    onDoctorMicActiveChangeRef.current?.(active);
  }

  function setMicReady(ready: boolean, reason: string) {
    if (micReadyRef.current === ready) return;
    micReadyRef.current = ready;
    recordTiming({ type: "doctor_mic_ready", reason: ready ? reason : "not_ready" });
    onMicReadyChangeRef.current?.(ready);
    if (!ready) setDoctorMicActive(false, reason);
    if (ready) {
      const active = transportRef.current?.setMicEnabled(desiredMicOnRef.current) ?? false;
      setDoctorMicActive(desiredMicOnRef.current && active, active ? "ready_apply_true" : "ready_apply_pending");
    }
  }

  function updateMicReady(reason: string) {
    setMicReady(Boolean(transportRef.current && remoteVideoReadyRef.current && remoteAudioReadyRef.current), reason);
  }

  // Arm a rep caption and HOLD it until the replica's audio actually starts, so the caption lands
  // with the voice instead of ahead of it (the greeting used to caption before it was spoken).
  // If the replica is already speaking, release now; otherwise a started-speaking event OR remote
  // audio activity releases it. The long timeout is only a no-drop fallback for browsers that block
  // audio metering; it is not the normal timing source.
  const CAPTION_SAFETY_MS = 12_000;
  function armRepCaption(input: { text: string; detailAidSlideId?: string | null; kind?: PendingRepEcho["kind"] }) {
    const t = input.text.trim();
    if (!t) return;
    // A NEW turn arrived (often a barge-in) before the previous caption was released. FLUSH the
    // previous one (show it) rather than dropping it — else an answer the rep already started
    // speaking never lands in the transcript. Idempotent: no-op if it was already released.
    void notifyPendingRepEcho("superseded", true);
    const pending: PendingRepEcho = {
      text: t,
      detailAidSlideId: input.detailAidSlideId ?? null,
      kind: input.kind ?? "answer",
      notified: false,
      queuedAt: Date.now(),
    };
    pendingRepEchoRef.current = pending;
    markRepLikelySpeaking(t, 2_500);
    if (repSpeakingRef.current) { void notifyPendingRepEcho("already_speaking"); return; }
    void (async () => {
      const audio = await waitForAgentAudioActivity(CAPTION_SAFETY_MS - 500);
      if (pendingRepEchoRef.current !== pending || pending.notified || repSpeakingRef.current) return;
      if (audio.started) markRepAudioStart("audio_meter_started", pending.text);
    })();
    pending.timer = window.setTimeout(() => { void notifyPendingRepEcho("safety_timeout"); }, CAPTION_SAFETY_MS);
  }

  function recordTiming(event: Omit<TimingEvent, "at">) {
    const w = window as unknown as { __nexusrepTiming?: TimingEvent[] };
    w.__nexusrepTiming = [...(w.__nexusrepTiming ?? []).slice(-600), { at: Date.now(), ...event }];
  }

  function markRepLikelySpeaking(text: string, tailMs = 1_500): number {
    const until = Date.now() + estimateReplicaSpeechMs(text) + tailMs;
    repLikelySpeakingUntilRef.current = Math.max(repLikelySpeakingUntilRef.current, until);
    return until;
  }

  function shouldInterruptDoctorInput(): boolean {
    return repSpeakingRef.current || Boolean(pendingRepEchoRef.current) || Date.now() < repLikelySpeakingUntilRef.current;
  }

  function markRepAudioStart(reason: string, speechText?: string) {
    const wasSpeaking = repSpeakingRef.current;
    const pending = pendingRepEchoRef.current;
    const spoken = speechText ?? pending?.text ?? "";
    repSpeakingRef.current = true;
    repDoneWaitersRef.current.forEach((w) => { w.started = true; }); // this echo is now audibly playing
    if (repStopFallbackRef.current) window.clearTimeout(repStopFallbackRef.current);
    const fallbackUntil = markRepLikelySpeaking(spoken);
    recordTiming({ type: "vendor_started_speaking", reason, text: spoken, detailAidSlideId: pending?.detailAidSlideId ?? null, captionKind: pending?.kind });
    if (!wasSpeaking && pending?.kind !== "greeting") {
      onRepAudioStartRef.current?.();
      reportTurnLatency();
    }
    void notifyPendingRepEcho(reason);
    const fallbackMs = Math.max(2_000, fallbackUntil - Date.now());
    repStopFallbackRef.current = window.setTimeout(() => {
      repSpeakingRef.current = false;
      if (repLikelySpeakingUntilRef.current <= fallbackUntil + 100) repLikelySpeakingUntilRef.current = 0;
      recordTiming({ type: "vendor_stopped_speaking", reason: "estimated_audio_end" });
      flushRepDoneWaiters(); // estimated end also advances a paced overview walk
    }, fallbackMs);
  }

  function markRepAudioStop(reason: string) {
    repSpeakingRef.current = false;
    repLikelySpeakingUntilRef.current = 0;
    if (repStopFallbackRef.current) {
      window.clearTimeout(repStopFallbackRef.current);
      repStopFallbackRef.current = null;
    }
    recordTiming({ type: "vendor_stopped_speaking", reason });
    flushRepDoneWaiters(); // advance a paced overview walk to the next segment
  }

  function cancelCurrentRepForBargeIn(reason: string) {
    if (repSpeakingRef.current) {
      markRepAudioStop(reason);
    } else if (pendingRepEchoRef.current) {
      dropPendingRepCaption(reason);
    }
    repLikelySpeakingUntilRef.current = 0;
    if (repStopFallbackRef.current) {
      window.clearTimeout(repStopFallbackRef.current);
      repStopFallbackRef.current = null;
    }
  }

  function dropPendingRepCaption(reason: string) {
    const pending = pendingRepEchoRef.current;
    if (!pending) return;
    const sid = sessionIdRef.current;
    pending.notified = true;
    if (pending.timer) window.clearTimeout(pending.timer);
    pendingRepEchoRef.current = null;
    recordTiming({
      type: "caption_drop",
      reason,
      delayMs: Date.now() - pending.queuedAt,
      text: pending.text,
      detailAidSlideId: pending.detailAidSlideId ?? null,
      captionKind: pending.kind,
    });
    if (pending.kind === "answer" && serverLogsRef.current && sid && /^hcp_|typed_barge_in|safe_interrupt/.test(reason)) {
      void fetch("/api/sessions/utterance/interrupted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, text: pending.text }),
      }).catch(() => undefined);
    }
  }

  function cancelPendingGreeting(reason: string): boolean {
    let cancelled = false;
    if (greetingTimerRef.current) {
      window.clearTimeout(greetingTimerRef.current);
      greetingTimerRef.current = null;
      cancelled = true;
    }
    if (pendingRepEchoRef.current?.kind === "greeting") {
      dropPendingRepCaption(reason);
      cancelled = true;
    }
    if (cancelled && !repSpeakingRef.current) {
      repLikelySpeakingUntilRef.current = 0;
      if (repStopFallbackRef.current) {
        window.clearTimeout(repStopFallbackRef.current);
        repStopFallbackRef.current = null;
      }
    }
    if (cancelled) recordTiming({ type: "greeting_cancelled", reason });
    return cancelled;
  }

  function setupAudioMeter(stream: MediaStream) {
    if (audioMeterStreamRef.current === stream && audioAnalyserRef.current) return;
    try {
      void audioCtxRef.current?.close().catch(() => undefined);
      const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const ctx = new AudioContextCtor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      audioAnalyserRef.current = analyser;
      audioMeterDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      audioMeterStreamRef.current = stream;
      recordTiming({ type: "remote_audio_meter_ready" });
    } catch {
      audioCtxRef.current = null;
      audioAnalyserRef.current = null;
      audioMeterDataRef.current = null;
      audioMeterStreamRef.current = null;
      recordTiming({ type: "remote_audio_meter_unavailable" });
    }
  }

  function remoteAudioLevel(): number {
    const analyser = audioAnalyserRef.current;
    const data = audioMeterDataRef.current;
    if (!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    return Math.sqrt(sum / data.length);
  }

  async function waitForAgentAudioActivity(timeoutMs: number): Promise<{ started: boolean; peak: number }> {
    const start = Date.now();
    let consecutive = 0;
    let peak = 0;
    const threshold = 0.018;
    if (!audioAnalyserRef.current) return { started: false, peak };
    while (Date.now() - start < timeoutMs) {
      try {
        if (audioCtxRef.current?.state === "suspended") await audioCtxRef.current.resume();
      } catch {
        // If the browser refuses the audio context, we fall back to the timeout path below.
      }
      const level = remoteAudioLevel();
      peak = Math.max(peak, level);
      if (level >= threshold) {
        consecutive += 1;
        if (consecutive >= 2) return { started: true, peak };
      } else {
        consecutive = 0;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    }
    return { started: false, peak };
  }

  // When the replica starts speaking, the doctor's turn is fully measured: log its per-stage
  // latency ONCE — to the browser console AND to the server (so it shows in Render logs beside
  // [tavus-llm-latency], giving the whole pipeline in one place).
  function reportTurnLatency() {
    const t = ((window as unknown as { __nexusrepTiming?: TimingEvent[] }).__nexusrepTiming) ?? [];
    const q = [...t].reverse().find((e) => e.type === "hcp_final_utterance");
    if (!q || q.at === lastLatencyTurnRef.current) return; // greeting / already-reported turn
    lastLatencyTurnRef.current = q.at;
    const stopped = [...t].reverse().find((e) => e.type === "hcp_stopped_speaking" && e.at <= q.at);
    const repText = t.find((e) => e.type === "rep_final_utterance" && e.at >= q.at);
    const firstVendorRepText = t.find((e) => e.type === "vendor_streaming_utterance" && e.at >= q.at);
    const finalVendorRepText = t.find((e) => e.type === "vendor_final_utterance" && e.at >= q.at);
    const now = Date.now();
    const answerAudioStart = t.find((e) => e.type === "vendor_started_speaking" && e.at <= now && e.at >= q.at && e.captionKind !== "greeting");
    // Split asrMs to attribute it. Scope this turn's user partials to (prevFinal, q]. Then:
    //   sttTailAfterStopMs = VAD-stop → last partial   → STT still transcribing after silence (STT-side)
    //   finalizeMs         = last partial → final txt   → dead time after the last word (turn-confirm)
    // These two sum to asrMs when the last partial falls between stop and final. partialCount 0 ⇒
    // Tavus streamed no user partials, so the whole asrMs is opaque buffering — itself an STT-side tell.
    const prevFinal = [...t].reverse().find((e) => e.type === "hcp_final_utterance" && e.at < q.at);
    const windowStart = prevFinal?.at ?? 0;
    const partials = t.filter((e) => e.type === "hcp_streaming_utterance" && e.at > windowStart && e.at <= q.at);
    const lastPartial = partials[partials.length - 1];
    const payload = {
      question: (q.text ?? "").slice(0, 60),
      asrMs: stopped ? q.at - stopped.at : null, // speech end → transcript (ASR / turn detection)
      partialCount: partials.length, // user streaming partials seen this turn (0 ⇒ no visibility into the split)
      sttTailAfterStopMs: stopped && lastPartial ? lastPartial.at - stopped.at : null, // STT still transcribing after silence
      finalizeMs: lastPartial ? q.at - lastPartial.at : null, // last partial → final transcript (turn-confirm)
      transcriptToAudioMs: now - q.at, // HCP final transcript → replica audio start (server callback + Tavus TTS/queue)
      firstVendorTextToAudioMs: firstVendorRepText ? now - firstVendorRepText.at : null, // Tavus emitted first text → audio
      finalVendorTextToAudioMs: finalVendorRepText ? now - finalVendorRepText.at : null, // Tavus emitted final text → audio
      repFinalUtteranceToAudioMs: repText ? now - repText.at : null, // canonical rep utterance event → audio
      audioStartReason: answerAudioStart?.reason ?? null,
    };
    // eslint-disable-next-line no-console
    console.info("[nexusrep-latency]", payload);
    const sid = sessionIdRef.current;
    void fetch("/api/metrics/latency", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sessionId: sid }),
    }).catch(() => { /* metrics are best-effort */ });
  }

  async function recordAgentAudioActivity(reason: string) {
    const startedAt = Date.now();
    const audio = await waitForAgentAudioActivity(3000);
    recordTiming({
      type: "vendor_audio_activity",
      reason,
      delayMs: Date.now() - startedAt,
      audioStarted: audio.started,
      level: audio.peak,
    });
  }

  async function hydratedRepTurn(sessionId: string, utterance: string): Promise<RepTurnNotice> {
    let notice: RepTurnNotice = { text: utterance };
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) return notice;
      const data = (await res.json()) as { turns?: SessionTurnNotice[] };
      const reps = (data.turns ?? []).filter((t) => t?.speaker === "rep" && t.text);
      const normalized = utterance.replace(/\s+/g, " ").trim();
      const turn =
        [...reps].reverse().find((t) => t.text.replace(/\s+/g, " ").trim() === normalized) ??
        [...reps].reverse().find((t) => t.detailAidSlideId) ??
        [...reps].reverse().find((t) => t.text);
      if (turn) notice = { ...turn, text: utterance };
    } catch {
      // Slide hydration is best-effort; the spoken caption is still useful to the UI.
    }
    return notice;
  }


  // skipHydrate: release the caption NOW with the text/slide we already hold, without the
  // best-effort session fetch. Used when the call is ENDING — otherwise the last answer the rep
  // spoke would be dropped on unmount while its (held) caption was still waiting to be released.
  async function notifyPendingRepEcho(reason = "vendor_started", skipHydrate = false) {
    const pending = pendingRepEchoRef.current;
    const notify = onRepTurnRef.current;
    if (!pending || pending.notified || !notify) return;
    pending.notified = true;
    if (pending.timer) window.clearTimeout(pending.timer);
    // Release the single pending slot NOW, BEFORE the async slide hydration below. Previously the
    // slot stayed occupied across the await and a sequence re-check dropped the turn if a newer
    // answer arrived meanwhile — so under a backed-up voice queue (answers landing back-to-back)
    // a real, spoken answer silently vanished from the transcript. The transcript is the audit
    // record: a produced answer must ALWAYS land. Suppressing re-emits is the consumer's job
    // (syncVideoRepTurn), which now dedups only a consecutive repeat, so this can't double a bubble.
    pendingRepEchoRef.current = null;
    recordTiming({
      type: "caption_release",
      reason,
      delayMs: Date.now() - pending.queuedAt,
      text: pending.text,
      detailAidSlideId: pending.detailAidSlideId ?? null,
    });
    const sid = sessionIdRef.current;
    let notice: RepTurnNotice = { text: pending.text, detailAidSlideId: pending.detailAidSlideId };
    if (!skipHydrate && serverLogsRef.current && sid) {
      const hydrated = await hydratedRepTurn(sid, pending.text);
      notice = {
        ...hydrated,
        // When Tavus emits a short finalized fragment ("Sure,", "Milvexian") before the settled
        // utterance, the authoritative session already has the full approved/gated rep turn. Show
        // that server turn in the captions; the vendor fragment is only a timing trigger.
        text: hydrated.text || pending.text,
        detailAidSlideId: hydrated.detailAidSlideId ?? pending.detailAidSlideId,
        sourceIds: hydrated.sourceIds,
      };
    }
    notify(notice);
  }

  useEffect(() => {
    const w = window as unknown as { __nexusrepVideoAgent?: unknown; __nexusrepLatency?: unknown };
    w.__nexusrepVideoAgent = { speak: speakAgent, getStage: () => stage, getNote: () => note };
    // One-call full-pipeline latency probe. Run window.__nexusrepLatency() in the console during a
    // live video call: for each doctor turn it breaks the round-trip into the three stages the user
    // feels — ASR/turn-detection (doctor stops → transcript), think (transcript → replica starts
    // speaking = our endpoint compose/gate + Tavus TTS render), and the caption offset. Pair with
    // the server's [tavus-llm-latency] log to split "think" into our-endpoint vs Tavus-TTS.
    w.__nexusrepLatency = () => {
      const t = (((window as unknown as { __nexusrepTiming?: TimingEvent[] }).__nexusrepTiming) ?? []).slice().sort((a, b) => a.at - b.at);
      const nextAfter = (i: number, type: string) => t.find((e, j) => j > i && e.type === type);
      const prevBefore = (i: number, type: string) => [...t].slice(0, i).reverse().find((e) => e.type === type);
      const turns = t
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "hcp_final_utterance")
        .map(({ e, i }) => {
          const stopped = prevBefore(i, "hcp_stopped_speaking");
          const repText = nextAfter(i, "rep_final_utterance");
          const interrupted = repText
            ? t.find((x, j) => j > i && x.at >= repText.at && x.type === "caption_drop" && x.captionKind === "answer")
            : undefined;
          const repSpoke = t.find((x, j) =>
            j > i &&
            x.type === "vendor_started_speaking" &&
            x.captionKind !== "greeting" &&
            (!repText || x.at >= repText.at) &&
            (!interrupted || x.at < interrupted.at),
          );
          // asrMs split (see reportTurnLatency): partials scoped to (prevFinal, e].
          const prevFinal = prevBefore(i, "hcp_final_utterance");
          const ws = prevFinal?.at ?? 0;
          const partials = t.filter((x) => x.type === "hcp_streaming_utterance" && x.at > ws && x.at <= e.at);
          const lastPartial = partials[partials.length - 1];
          return {
            question: (e.text ?? "").slice(0, 48),
            asrMs: stopped ? e.at - stopped.at : null, // speech end → finalized transcript
            partials: partials.length, // 0 ⇒ Tavus gave us no user partials (split unavailable)
            sttTailAfterStopMs: stopped && lastPartial ? lastPartial.at - stopped.at : null, // STT still transcribing after silence
            finalizeMs: lastPartial ? e.at - lastPartial.at : null, // last partial → final transcript (turn-confirm)
            interruptedBeforeAudio: Boolean(interrupted && !repSpoke),
            thinkToVoiceMs: repSpoke ? repSpoke.at - e.at : null, // transcript → replica audio (endpoint + TTS)
            transcriptToVoiceMs: repText && repSpoke ? repSpoke.at - repText.at : null, // rep text ready → rep audio (~TTS render)
          };
        });
      console.table(turns);
      return turns;
    };
  });

  useEffect(() => {
    if (deferredCleanupRef.current) {
      window.clearTimeout(deferredCleanupRef.current);
      deferredCleanupRef.current = null;
    }
    const runId = ++startupRunRef.current;
    let cancelled = false;
    let localConversationId = "";
    const endLocalConversation = (conversationId: string) => {
      if (!conversationId) return;
      try {
        void fetch("/api/realtime/conversation/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, reason: "cleanup" }), // silent unmount/tab-close backstop
          keepalive: true,
        });
      } catch { /* best-effort */ }
    };
    const conversationIdFromUrl = (url: string) => {
      try { return new URL(url).pathname.split("/").filter(Boolean).pop() || ""; } catch { return ""; }
    };
    void (async () => {
      try {
        const res = await fetch("/api/realtime/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Invite-link identity — server honors it only for a real cohort member.
          body: JSON.stringify({ ...(hcpId ? { hcpId } : {}), startNonce: startNonceRef.current }),
        });
        // The server always returns JSON — but an OOM/502 or gateway error yields an
        // HTML error page. Parse defensively so we show a clean note instead of crashing
        // with "Unexpected token '<'", and fall back to the built-in avatar.
        const raw = await res.text();
        let d: ConvResp;
        try {
          d = JSON.parse(raw) as ConvResp;
        } catch {
          onSessionReadyRef.current?.(null);
          setNote(`Couldn't start the video rep: the service returned an error (HTTP ${res.status}). It may be out of memory or restarting — the built-in avatar still works.`);
          setStage("unconfigured");
          return;
        }
        if (!d.configured || !d.conversationUrl) {
          onSessionReadyRef.current?.(null);
          setNote(d.note);
          setStage("unconfigured");
          return;
        }
        localConversationId = conversationIdFromUrl(d.conversationUrl);
        if (cancelled) {
          if (startupRunRef.current === runId) endLocalConversation(localConversationId);
          return;
        }
        sessionIdRef.current = d.sessionId ?? null;
        greetingRef.current = d.greeting ?? null;
        convIdRef.current = localConversationId;
        const sessionNotice = { sessionId: d.sessionId ?? null, conversationUrl: d.conversationUrl };
        onSessionReadyRef.current?.(sessionNotice);
        // Expose ids for automation/QA (the record bot reads these to attach the
        // recording to the right session). Harmless in normal use; production UI state uses
        // onSessionReady, not this debug/global hook.
        (window as unknown as { __nexusrep?: unknown }).__nexusrep = sessionNotice;
        if (d.reachableLlm === false) setNote(d.note);
        // Reachable → the server's compliance endpoint is the transcript source of truth.
        serverLogsRef.current = d.reachableLlm === true;
        setStage("joining");

        const transport = createVideoTransport(d.provider, { conversationUrl: d.conversationUrl, token: d.token });
        if (!transport) {
          onSessionReadyRef.current?.(null);
          setNote(`No client transport for the "${d.provider}" provider — the built-in avatar still works.`);
          setStage("unconfigured");
          return;
        }
        if (cancelled) {
          if (startupRunRef.current === runId) endLocalConversation(localConversationId);
          return;
        }
        transportRef.current = transport;

        // Bare/record mode: capture ONLY the agent stream (video+audio) starting when
        // the replica joins with BOTH media tracks. The greeting is queued only after
        // this recorder is live, so the first spoken words cannot be clipped.
        // Exposes window.__nexusrepRec.stop() → base64 webm for the recorder.
        let recStarted = false;
        let recReadyResolve: (() => void) | null = null;
        const recReady = new Promise<void>((resolve) => { recReadyResolve = resolve; });
        const recWanted = () => bare || recordSessionRef.current || (window as unknown as { __nexusrepRecord?: boolean }).__nexusrepRecord === true;
        const waitForRecReady = async (timeoutMs: number) => {
          if (!recWanted() || recStarted) return;
          await Promise.race([
            recReady,
            new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
          ]);
        };
        const maybeStartRec = (allowVideoOnly = false) => {
          // Record when in bare mode OR when a recorder set window.__nexusrepRecord
          // (used to capture an agent-only clip of a full multi-turn doctor session).
          if (!recWanted() || recStarted || typeof MediaRecorder === "undefined") return false;
          const vs = videoRef.current?.srcObject as MediaStream | null;
          const as = audioRef.current?.srcObject as MediaStream | null;
          const tracks = [...(vs?.getVideoTracks() ?? []), ...(as?.getAudioTracks() ?? [])];
          const hasVideo = tracks.some((t) => t.kind === "video");
          const hasAudio = tracks.some((t) => t.kind === "audio");
          if (!hasVideo || (!hasAudio && !allowVideoOnly)) return false; // wait for the media pair
          recStarted = true;
          try {
            const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
            const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime });
            const chunks: BlobPart[] = [];
            const startedAt = Date.now();
            // Stream chunks for the INTERACTIVE doctor recording (recordSession, not bare/script capture
            // which the record scripts upload as one blob). A 2s timeslice keeps the end-of-call flush small.
            const streamActive = recordSessionRef.current && !bare;
            recStreamRef.current = { active: streamActive, mime, startedAt, uploaded: 0, chain: Promise.resolve() };
            rec.ondataavailable = (e) => {
              if (e.data && e.data.size) chunks.push(e.data);
              if (streamActive) pumpRecordingUploads(); // fire off the newly-available chunk right away
            };
            rec.start(streamActive ? 2000 : 1000);
            // Hold the live recorder so finalizeRecording() can stop + flush it when the call ends.
            recorderRef.current = { chunks, mime, stop: () => { try { if (rec.state !== "inactive") { rec.requestData(); rec.stop(); } } catch { /* already stopped */ } } };
            recordTiming({ type: "recording_started", reason: streamActive ? "streaming" : hasAudio ? "media_tracks" : "video_only_fallback" });
            (window as unknown as { __nexusrepRec?: unknown }).__nexusrepRec = {
              mimeType: mime,
              startedAt,
              timings: () => ((window as unknown as { __nexusrepTiming?: TimingEvent[] }).__nexusrepTiming ?? []),
              stop: () =>
                new Promise<string>((resolve) => {
                  let settled = false;
                  const finish = async () => {
                    if (settled) return;
                    settled = true;
                    recordTiming({ type: "recording_stopped" });
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
            recReadyResolve?.();
            recReadyResolve = null;
            return true;
          } catch {
            recStarted = false;
            return false;
          }
        };

        await transport.join({
          onTrack: (kind, stream) => {
            if (kind === "video" && videoRef.current) {
              videoRef.current.srcObject = stream;
              void videoRef.current.play?.();
              setHasVideo(true);
              remoteVideoReadyRef.current = true;
              updateMicReady("remote_video");
              // A dying track (vendor shutdown, network) must not leave a frozen black
              // frame — drop back to the status area, which explains what happened.
              const track = stream.getVideoTracks()[0];
              if (track) track.onended = () => {
                remoteVideoReadyRef.current = false;
                updateMicReady("remote_video_ended");
                setHasVideo(false);
              };
            }
            if (kind === "audio" && audioRef.current) {
              audioRef.current.srcObject = stream;
              setupAudioMeter(stream);
              void audioRef.current.play?.();
              remoteAudioReadyRef.current = true;
              updateMicReady("remote_audio");
              const track = stream.getAudioTracks()[0];
              if (track) track.onended = () => {
                remoteAudioReadyRef.current = false;
                updateMicReady("remote_audio_ended");
              };
            }
            // Start the recorder as soon as the replica has joined with both video+audio. If the
            // audio track never appears, a late video-only fallback captures a debuggable clip, but
            // the normal path is the media pair above.
            if (kind === "video" || kind === "audio") {
              maybeStartRec();
              if (kind === "video") window.setTimeout(() => maybeStartRec(true), 6000);
            }
            // Speak the opening greeting as a NORMAL (interruptible) echoed utterance, once the
            // replica is live. We don't use Tavus's custom_greeting (always non-interruptible); this
            // way the doctor can barge in over it (mic live + replica_interruptibility). Pure echo (no
            // interrupt). In record mode, wait until MediaRecorder is live before queuing it.
            if (kind === "video" && !greetedRef.current) {
              const g = greetingRef.current;
              if (g) {
                greetedRef.current = true;
                void (async () => {
                  await waitForRecReady(5000);
                  greetingTimerRef.current = window.setTimeout(() => {
                  greetingTimerRef.current = null;
                  transportRef.current?.speak(g, false);
                  // Caption it ourselves: an echoed greeting doesn't reliably emit a Tavus utterance
                  // event (the native custom_greeting did), so without this the opening never lands
                  // in the transcript. armRepCaption releases it with the voice (or the safety timer).
                  armRepCaption({ text: g, kind: "greeting" });
                  }, recWanted() ? 250 : 900);
                })();
              }
            }
          },
          onRawEvent: (e) => {
            // QA aid: record ALL conversation events so tests can see what the agent
            // does after an echo (started/stopped speaking, utterances). Harmless.
            const w = window as unknown as { __nexusrepEvents?: { type: string; role: string; text: string }[] };
            w.__nexusrepEvents = [...(w.__nexusrepEvents ?? []).slice(-40), { ...e, text: e.text.slice(0, 160) }];
            const repEvent = isRepRawEvent(e);
            const hcpEvent = isHcpRawEvent(e);
            if (repEvent) {
              if (/conversation\.utterance\.streaming/i.test(e.type)) {
                recordTiming({ type: "vendor_streaming_utterance", reason: e.type, role: e.role, text: e.text.slice(0, 160) });
              } else if (/conversation\.utterance$/i.test(e.type)) {
                recordTiming({ type: "vendor_final_utterance", reason: e.type, role: e.role, text: e.text.slice(0, 160) });
              }
            }
            // The replica's audio started → release the held caption so it lands WITH the voice, AND
            // anchor the detail-aid slide switch here: the parent counts the cue offset from NOW, so
            // the deck changes as the rep reaches the cue — never seconds before it (the old
            // streaming-text trigger fired well ahead of the spoken word with a custom LLM).
            if (
              /start(?:ed)?[_\s.-]*speak|speech[_\s.-]*start|speaking[_\s.-]*start/i.test(e.type) &&
              repEvent
            ) {
              markRepAudioStart(e.type);
              void recordAgentAudioActivity(e.type);
            }
            // The replica finished speaking → the next turn's caption must wait for its own audio.
            if (
              /stop(?:ped)?[_\s.-]*speak|speech[_\s.-]*(?:stop|end)|speaking[_\s.-]*(?:stop|end)|done[_\s.-]*speak/i.test(e.type) &&
              repEvent
            ) {
              markRepAudioStop(e.type);
            }
            // Doctor (HCP) speech-detection markers — the start of the pipeline. The gap from
            // hcp_stopped_speaking → the doctor's finalized transcript is the ASR/turn-detection
            // latency; from there → vendor_started_speaking is our endpoint + Tavus TTS. See
            // window.__nexusrepLatency() for the per-turn breakdown.
            if (hcpEvent) {
              if (/conversation\.utterance\.streaming/i.test(e.type)) {
                // User partial transcripts, IF Tavus streams them for the user role. Timestamped so
                // reportTurnLatency can split asrMs into STT-tail (VAD-stop → last partial: STT still
                // transcribing) vs finalize (last partial → final transcript: turn-confirm dead time).
                // partialCount 0 across a session ⇒ Tavus emits no user partials and buffers the whole
                // utterance, which itself points the finger at STT-side finalization.
                recordTiming({ type: "hcp_streaming_utterance", reason: e.type, text: e.text });
              } else if (/start(?:ed)?[_\s.-]*speak/i.test(e.type)) {
                // VAD only: this can fire immediately after the doctor turns the mic on, before
                // any words exist. Mic-on/noise is NOT an interrupt, but a Tavus USER speech-start
                // event while the replica is speaking is the earliest safe point to stop the agent's
                // audio so the greeting does not mask the question ASR.
                recordTiming({ type: "hcp_started_speaking", reason: e.type });
                if (shouldInterruptDoctorInput()) {
                  transportRef.current?.stopAgentSpeech();
                  cancelCurrentRepForBargeIn("hcp_speech_start_native");
                  // Drop any still-pending detail-aid switch at the SAME moment we interrupt the rep,
                  // not later when the utterance finalizes — otherwise a slide armed for the answer the
                  // doctor just barged over could still fire (≤4s cap) and flash before their new turn.
                  // Gated on shouldInterruptDoctorInput() so mic-on/noise never drops a legit cue.
                  onHcpSpeechStartRef.current?.();
                  recordTiming({ type: "hcp_start_during_rep", reason: "native_speech_start_interrupt" });
                }
              } else if (/stop(?:ped)?[_\s.-]*speak|done[_\s.-]*speak/i.test(e.type)) {
                recordTiming({ type: "hcp_stopped_speaking", reason: e.type });
              }
            }
            // The vendor ended the call (credits exhausted, duration cap, account limit).
            // Without this the pane just froze to black with no explanation.
            if (/shutdown|call_ended|conversation.ended/i.test(e.type)) {
              void notifyPendingRepEcho("call_ended", true); // flush the last spoken answer's caption
              setHasVideo(false);
              setNote("The video call was ended by the provider — this usually means the account is out of conversational credits or hit a limit. Close the video and try again once that's resolved.");
              setStage("ended");
            }
          },
          onMicState: (s) => {
            recordTiming({
              type: "doctor_mic_transport_state",
              reason: s.reason,
              level: s.level,
              audioStarted: s.localAudio,
            });
            setDoctorMicActive(s.desired && s.localAudio, s.reason);
          },
          onUtterance: ({ speaker, text }) => {
            // ASR silence/noise artifacts are not speech — never caption or log them.
            if (/^\s*[[(]\s*(?:blank[_ ]?audio|inaudible|silence|no[_ ]?speech|noise|music|applause|laughter)\s*[\])]\s*$/i.test(text)) return;
            const finalText = speaker === "hcp" ? (normalizeHcpUtteranceRef.current?.(text) ?? text) : text;
            // Recording should already be live before the greeting is queued. This late call is only
            // a defensive fallback if a browser withheld the audio track events.
            if (speaker === "rep") maybeStartRec(true);
            // The doctor's SPOKEN words must appear in the captions like typed ones do —
            // without this, a voice-only conversation has no "You" lines at all. (Barge-in
            // is handled by Tavus native turn-taking. Do not send a manual interrupt here: this is
            // still part of the microphone path, and the manual stop can race Tavus's finalized
            // utterance → custom-LLM handoff and make the real question appear "eaten".)
            if (speaker === "hcp") {
              onHcpSpeechStartRef.current?.();
              cancelPendingGreeting("hcp_final_utterance");
              const normalizedFinal = finalText.replace(/\s+/g, " ").trim();
              const typed = typedRespondRef.current;
              const isTypedRespondEcho = Boolean(
                typed &&
                Date.now() - typed.at < 20_000 &&
                typed.text === normalizedFinal,
              );
              if (shouldInterruptDoctorInput() && !isTypedRespondEcho) {
                // Safe barge-in point: Tavus has already finalized the doctor's words and called
                // our custom LLM, so interrupting now cannot consume the question. It just clears
                // an echoed greeting/old answer that Tavus sometimes leaves playing, which otherwise
                // queues the new approved reply several seconds behind stale audio.
                transportRef.current?.stopAgentSpeech();
                cancelCurrentRepForBargeIn("hcp_final_native");
                recordTiming({ type: "hcp_final_during_rep", reason: "finalized_safe_interrupt" });
              } else if (isTypedRespondEcho) {
                recordTiming({ type: "hcp_final_typed_echo", text: finalText });
                typedRespondRef.current = null;
              }
              onHcpUtterance?.(finalText);
            }
            const sid = sessionIdRef.current;
            if (!sid) return;
            const key = `${speaker}:${finalText}`;
            if (key === lastUtterRef.current) return; // client-side dedup of re-emits
            lastUtterRef.current = key;
            // Finalized-transcript marker (one per unique utterance) — the ASR output timestamp.
            recordTiming({ type: speaker === "hcp" ? "hcp_final_utterance" : "rep_final_utterance", text: finalText });
            // Only log from the client when the server can't (unreachable compliance endpoint).
            // When reachable, the server already logged this turn with its slideId.
            if (serverLogsRef.current) {
              // Greeting / voice-driven turn (a typed echo already armed its own caption with the
              // slide id): arm the caption and let it release when the replica's audio starts, so
              // it doesn't appear before the voice. Duplicate suppression happens caption-side.
              // Arm a caption for a genuinely new rep utterance. Skip ONLY when this exact text is
              // already the pending caption — a typed ask we armed ourselves, now echoed back by
              // Tavus; re-arming that would double it. A DIFFERENT utterance arriving while one is
              // still pending is a real new turn: arm it (armRepCaption flushes the previous first)
              // so back-to-back answers under a backed-up voice queue can never drop one.
              if (speaker === "rep") {
                const pend = pendingRepEchoRef.current;
                const norm = (s: string) => s.replace(/\s+/g, " ").trim();
                if (!pend || norm(pend.text) !== norm(text)) armRepCaption({ text, kind: "answer" });
              }
              return;
            }
            void fetch("/api/sessions/utterance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: sid, speaker, text: finalText }),
            });
            if (speaker === "rep") onRepTurnRef.current?.({ text: finalText });
          },
        });
        if (cancelled) {
          transport.leave();
          if (transportRef.current === transport) transportRef.current = null;
          if (startupRunRef.current === runId) endLocalConversation(localConversationId);
          return;
        }
        // join() intentionally starts muted to avoid hot-mic surprises. If the doctor clicked the
        // mic while the room was still joining, reapply that desired state after Daily's join-side
        // setLocalAudio(false) has run; otherwise the UI says "on" while WebRTC is still muted.
        updateMicReady("join_complete");
        setStage("live");
        maybeStartRec(); // in case both tracks arrived before join resolved
      } catch (e) {
        if (cancelled) return;
        onSessionReadyRef.current?.(null);
        setNote(e instanceof Error ? e.message : String(e));
        setStage("error");
      }
    })();
    return () => {
      cancelled = true;
      deferredCleanupRef.current = window.setTimeout(() => {
        if (startupRunRef.current !== runId) return;
      // Flush (not drop) any held caption so the LAST answer the rep spoke still lands in the
      // transcript when the doctor ends the call before its release fired. Synchronous (skipHydrate).
      void notifyPendingRepEcho("unmount", true);
      // Best-effort: capture the recording if the call is torn down without the End button (nav away).
      // The reliable path is the End button, which awaits this before closing.
      void finalizeRecording();
      transportRef.current?.leave();
      transportRef.current = null;
      onSessionReadyRef.current?.(null);
      remoteVideoReadyRef.current = false;
      remoteAudioReadyRef.current = false;
      setMicReady(false, "unmount");
      setDoctorMicActive(false, "unmount");
      void audioCtxRef.current?.close().catch(() => undefined);
      audioCtxRef.current = null;
      audioAnalyserRef.current = null;
      audioMeterDataRef.current = null;
      audioMeterStreamRef.current = null;
      // Leaving the room does NOT end the vendor conversation — it lingers and holds a
      // concurrent-session slot until the vendor times it out. End it explicitly so repeated
      // previews don't pile up to the account cap. keepalive: survives the unmount/navigation.
      const cid = convIdRef.current || localConversationId;
      if (cid) {
        endLocalConversation(cid);
      }
      convIdRef.current = "";
      const cur = window as unknown as { __nexusrep?: unknown; __nexusrepVideoAgent?: unknown; __nexusrepLatency?: unknown };
      delete cur.__nexusrep;
      delete cur.__nexusrepVideoAgent;
      delete cur.__nexusrepLatency;
      }, 750);
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
          <button onClick={() => { void finalizeRecording().finally(() => { endConversationNow(); onClose(); }); }} style={{ background: "rgba(255,255,255,.15)", color: "#fff", border: "1px solid rgba(255,255,255,.3)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>End video</button>
        </div>
      )}
    </div>
  );
});
