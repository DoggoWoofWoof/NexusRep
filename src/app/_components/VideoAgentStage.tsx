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
type TimingEvent = {
  type: string;
  at: number;
  reason?: string;
  delayMs?: number;
  text?: string;
  detailAidSlideId?: string | null;
  audioStarted?: boolean;
  level?: number;
};

/** Imperative handle so platform-controlled scripted segments can make the agent
 *  speak gated text verbatim via transport echo. Normal HCP typed turns use
 *  `respond()` so Tavus runs the same custom-LLM path as microphone input. */
export interface VideoAgentStageHandle {
  speak: (text: string, detailAidSlideId?: string | null) => boolean;
  respond: (text: string) => boolean;
  /** Mute/unmute the AGENT's audio (what the doctor hears). */
  setMuted: (muted: boolean) => void;
  /** Enable/disable the doctor's own microphone on the call. */
  setMicEnabled: (on: boolean) => void;
}

type RepTurnNotice = { text: string; detailAidSlideId?: string | null; sourceIds?: string[] };
type PendingRepEcho = { text: string; detailAidSlideId?: string | null; timer?: number; notified: boolean; queuedAt: number };

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
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioMeterDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const audioMeterStreamRef = useRef<MediaStream | null>(null);
  // Client-side echo turns (typed asks while video is on) may not always be echoed back as a
  // Tavus finalized utterance. Keep the pending gated text here so the transcript can still be
  // written when the replica starts speaking, with the slide id already known.
  const pendingRepEchoRef = useRef<PendingRepEcho | null>(null);
  // True while the replica is currently producing audio (between started/stopped-speaking).
  // A caption armed while this is true is released at once (the voice is already out); one armed
  // before it flips releases when speaking starts — so the caption lands WITH the voice, either order.
  const repSpeakingRef = useRef(false);
  // The doctor question (hcp_final_utterance.at) whose latency we've already reported, so each turn
  // logs its ASR/think breakdown exactly once when the replica starts speaking.
  const lastLatencyTurnRef = useRef(0);

  // Make the agent speak our (already gated) text verbatim, via the transport.
  const speakAgent = (text: string, detailAidSlideId?: string | null): boolean => {
    const t = text.trim();
    if (!t) return false;
    const ok = transportRef.current?.speak(t) ?? false;
    if (!ok) return false;
    recordTiming({ type: "echo_queued", text: t, detailAidSlideId: detailAidSlideId ?? null });
    armRepCaption({ text: t, detailAidSlideId: detailAidSlideId ?? null });
    return true;
  };
  const applyMuted = (m: boolean) => { setMuted(m); onMutedChange?.(m); };
  useImperativeHandle(ref, () => ({
    speak: (text: string, detailAidSlideId?: string | null) => speakAgent(text, detailAidSlideId),
    respond: (text: string) => {
      const ok = transportRef.current?.respond(text) ?? false;
      if (ok) recordTiming({ type: "typed_respond_sent", text });
      return ok;
    },
    setMuted: (m: boolean) => { applyMuted(m); },
    setMicEnabled: (on: boolean) => { transportRef.current?.setMicEnabled(on); },
  }));
  // Guards React StrictMode's double-invoke of effects in dev — without it the
  // component opens TWO vendor conversations (wasted minutes + a concurrent-slot clash).
  const startedRef = useRef(false);
  const [stage, setStage] = useState<Stage>("loading");
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);
  // join() resolves before the agent publishes media — keep the connecting status up
  // until the first real frame instead of showing an empty black pane.
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    onRepTurnRef.current = onRepTurn;
  }, [onRepTurn]);

  // Arm a rep caption and HOLD it until the replica's audio actually starts, so the caption lands
  // with the voice instead of ahead of it (the greeting used to caption before it was spoken).
  // If the replica is already speaking, release now; otherwise a started-speaking event releases it,
  // and a safety timer releases it regardless so a caption can never get stuck or lost.
  const CAPTION_SAFETY_MS = 2500;
  function armRepCaption(input: { text: string; detailAidSlideId?: string | null }) {
    const t = input.text.trim();
    if (!t) return;
    // A NEW turn arrived (often a barge-in) before the previous caption was released. FLUSH the
    // previous one (show it) rather than dropping it — else an answer the rep already started
    // speaking never lands in the transcript. Idempotent: no-op if it was already released.
    void notifyPendingRepEcho("superseded", true);
    const pending: PendingRepEcho = {
      text: t,
      detailAidSlideId: input.detailAidSlideId ?? null,
      notified: false,
      queuedAt: Date.now(),
    };
    pendingRepEchoRef.current = pending;
    if (repSpeakingRef.current) { void notifyPendingRepEcho("already_speaking"); return; }
    pending.timer = window.setTimeout(() => { void notifyPendingRepEcho("safety_timeout"); }, CAPTION_SAFETY_MS);
  }

  function recordTiming(event: Omit<TimingEvent, "at">) {
    const w = window as unknown as { __nexusrepTiming?: TimingEvent[] };
    w.__nexusrepTiming = [...(w.__nexusrepTiming ?? []).slice(-120), { at: Date.now(), ...event }];
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
    const repText = [...t].reverse().find((e) => e.type === "rep_final_utterance" && e.at >= q.at);
    const now = Date.now();
    const payload = {
      question: (q.text ?? "").slice(0, 60),
      asrMs: stopped ? q.at - stopped.at : null, // speech end → transcript (ASR / turn detection)
      thinkToVoiceMs: now - q.at, // transcript → replica audio (our endpoint + Tavus TTS)
      transcriptToVoiceMs: repText ? now - repText.at : null, // rep text ready → audio (~TTS render)
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
        text: pending.text,
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
          const repSpoke = nextAfter(i, "vendor_started_speaking");
          const repText = nextAfter(i, "rep_final_utterance");
          return {
            question: (e.text ?? "").slice(0, 48),
            asrMs: stopped ? e.at - stopped.at : null, // speech end → finalized transcript
            thinkToVoiceMs: repSpoke ? repSpoke.at - e.at : null, // transcript → replica audio (endpoint + TTS)
            transcriptToVoiceMs: repText && repSpoke ? repSpoke.at - repText.at : null, // rep text ready → rep audio (~TTS render)
          };
        });
      console.table(turns);
      return turns;
    };
    return () => {
      const cur = window as unknown as { __nexusrepVideoAgent?: { speak?: unknown }; __nexusrepLatency?: unknown };
      if (cur.__nexusrepVideoAgent?.speak === speakAgent) { delete cur.__nexusrepVideoAgent; delete cur.__nexusrepLatency; }
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
            if (kind === "audio" && audioRef.current) {
              audioRef.current.srcObject = stream;
              setupAudioMeter(stream);
              void audioRef.current.play?.();
            }
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
            if (/replica|assistant|agent|ai|pal|face/i.test(e.role)) {
              if (/conversation\.utterance\.streaming/i.test(e.type)) {
                recordTiming({ type: "vendor_streaming_utterance", reason: e.type, text: e.text });
              } else if (/conversation\.utterance$/i.test(e.type)) {
                recordTiming({ type: "vendor_final_utterance", reason: e.type, text: e.text });
              }
            }
            // The replica's audio started → release the held caption so it lands WITH the voice.
            if (
              /start(?:ed)?[_\s.-]*speak|speech[_\s.-]*start|speaking[_\s.-]*start/i.test(e.type) &&
              (!e.role || /replica|assistant|agent|ai/i.test(e.role))
            ) {
              repSpeakingRef.current = true;
              recordTiming({ type: "vendor_started_speaking", reason: e.type });
              reportTurnLatency();
              void notifyPendingRepEcho("vendor_started");
              void recordAgentAudioActivity(e.type);
            }
            // The replica finished speaking → the next turn's caption must wait for its own audio.
            if (
              /stop(?:ped)?[_\s.-]*speak|speech[_\s.-]*(?:stop|end)|speaking[_\s.-]*(?:stop|end)|done[_\s.-]*speak/i.test(e.type) &&
              (!e.role || /replica|assistant|agent|ai/i.test(e.role))
            ) {
              repSpeakingRef.current = false;
            }
            // Doctor (HCP) speech-detection markers — the start of the pipeline. The gap from
            // hcp_stopped_speaking → the doctor's finalized transcript is the ASR/turn-detection
            // latency; from there → vendor_started_speaking is our endpoint + Tavus TTS. See
            // window.__nexusrepLatency() for the per-turn breakdown.
            if (/hcp|user|human|participant|remote/i.test(e.role)) {
              if (/start(?:ed)?[_\s.-]*speak/i.test(e.type)) {
                recordTiming({ type: "hcp_started_speaking", reason: e.type });
                // Barge-in: interrupt ONLY while the rep is actually speaking, so the doctor talking
                // over a (possibly long) answer drops it. Interrupting when the rep is NOT yet
                // speaking — a stray VAD blip during the connect/think window before the first answer
                // — cancels the pending response and the turn never recovers (the "frozen before it
                // speaks" bug). repSpeakingRef flips on the replica's own started/stopped events.
                if (repSpeakingRef.current) transportRef.current?.interrupt();
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
          onUtterance: ({ speaker, text }) => {
            // ASR silence/noise artifacts are not speech — never caption or log them.
            if (/^\s*[[(]\s*(?:blank[_ ]?audio|inaudible|silence|no[_ ]?speech|noise|music|applause|laughter)\s*[\])]\s*$/i.test(text)) return;
            // Begin the recording at the agent's FIRST words (the greeting) so the clip trims
            // the connect boot + any idle before the rep speaks. No-op once already recording.
            if (speaker === "rep") maybeStartRec();
            // The doctor's SPOKEN words must appear in the captions like typed ones do —
            // without this, a voice-only conversation has no "You" lines at all. (Barge-in
            // interrupt is handled on hcp_started_speaking, gated on the rep actually speaking —
            // interrupting from here fired on stray blips before the rep spoke and froze the turn.)
            if (speaker === "hcp") onHcpUtterance?.(text);
            const sid = sessionIdRef.current;
            if (!sid) return;
            const key = `${speaker}:${text}`;
            if (key === lastUtterRef.current) return; // client-side dedup of re-emits
            lastUtterRef.current = key;
            // Finalized-transcript marker (one per unique utterance) — the ASR output timestamp.
            recordTiming({ type: speaker === "hcp" ? "hcp_final_utterance" : "rep_final_utterance", text });
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
                if (!pend || norm(pend.text) !== norm(text)) armRepCaption({ text });
              }
              return;
            }
            void fetch("/api/sessions/utterance", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: sid, speaker, text }),
            });
            if (speaker === "rep") onRepTurnRef.current?.({ text });
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
      // Flush (not drop) any held caption so the LAST answer the rep spoke still lands in the
      // transcript when the doctor ends the call before its release fired. Synchronous (skipHydrate).
      void notifyPendingRepEcho("unmount", true);
      transportRef.current?.leave();
      transportRef.current = null;
      void audioCtxRef.current?.close().catch(() => undefined);
      audioCtxRef.current = null;
      audioAnalyserRef.current = null;
      audioMeterDataRef.current = null;
      audioMeterStreamRef.current = null;
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
