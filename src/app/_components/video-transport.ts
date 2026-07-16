"use client";

/**
 * Client-side video-call transport adapters. The stage component (VideoAgentStage)
 * speaks ONLY this generic interface; everything vendor-specific — SDKs, wire
 * protocols, event shapes, role vocabulary — lives inside a named transport
 * implementation. Adding a vendor = one new create*Transport function and one
 * registry entry; the stage, HCP view, and Studio never change.
 */

export interface VideoTransportEvents {
  /** A remote media track arrived (the agent's video/audio). */
  onTrack: (kind: "video" | "audio", stream: MediaStream) => void;
  /** A finalized utterance from either side of the call, in canonical speakers. */
  onUtterance: (u: { speaker: "rep" | "hcp"; text: string }) => void;
  /** Local doctor-mic state as reported by the WebRTC transport. */
  onMicState?: (s: { desired: boolean; localAudio: boolean; reason: string; level?: number }) => void;
  /** Raw vendor events, for QA visibility only (vendor vocabulary allowed here). */
  onRawEvent?: (e: { type: string; role: string; text: string }) => void;
}

export interface VideoCallTransport {
  /** Connect to the call and start delivering events. */
  join(events: VideoTransportEvents): Promise<void>;
  /** Make the agent speak our (already gated) text verbatim. False if not connected.
   *  bargeIn (default true) sends a brief interrupt before the echo so a typed ask cuts in over
   *  any in-progress speech; pass false for a PURE echo with no interrupt (e.g. the opening
   *  greeting on join, where there's nothing to interrupt and an interrupt could disrupt Tavus). */
  speak(text: string, bargeIn?: boolean): boolean;
  /** Send typed doctor text into the PAL as user input, so Tavus runs its fast response path. */
  respond(text: string, interrupt?: boolean): boolean;
  /** Stop currently queued/playing agent speech. Used only after a user turn is finalized. */
  stopAgentSpeech(): boolean;
  /** Enable/disable the doctor's microphone on the call (push-to-mute). */
  setMicEnabled(on: boolean): boolean;
  leave(): void;
}

interface TransportOptions {
  conversationUrl: string;
  token?: string | null;
}

/**
 * Tavus CVI transport: a Daily/WebRTC room plus Tavus "conversation.*" app-messages.
 * Echo/respond can send an interrupt for typed/scripted barge-in, but microphone
 * barge-in is handled by Tavus native turn-taking. This file is the ONLY client
 * code that knows Tavus's protocol (echo/interrupt/utterance, the "replica" role).
 */
function createTavusCviTransport(opts: TransportOptions): VideoCallTransport {
  type CallObj = {
    join: (o: { url: string; token?: string }) => Promise<unknown>;
    leave: () => void;
    destroy: () => Promise<void> | void;
    localAudio: () => boolean;
    setLocalAudio: (on: boolean, options?: { forceDiscardTrack: boolean }) => void;
    sendAppMessage: (data: unknown, to?: string) => void;
    on: (event: string, cb: (ev: unknown) => void) => void;
    startLocalAudioLevelObserver?: (interval?: number) => Promise<void>;
    stopLocalAudioLevelObserver?: () => void;
    isLocalAudioLevelObserverRunning?: () => boolean;
  };
  let call: CallObj | null = null;
  let localMicTrack: MediaStreamTrack | null = null;
  let rawMicStream: MediaStream | null = null;
  let gatedMicTrack: MediaStreamTrack | null = null;
  let micGateCtx: AudioContext | null = null;
  let micGate: GainNode | null = null;
  let usingSilentGate = false;
  // Set once the local-audio-level observer reports a frame after the mic is turned on — proof the
  // track is actually producing/sending audio (not merely toggled on). Reset on each turn-on so we
  // re-confirm capture rather than trusting a stale flag.
  let micLevelSeen = false;
  // When the mic was last turned on. We hold the UI "arming" (amber) for a fixed window from here
  // before reporting the mic as capturing — a deliberate warm-up so the WebRTC track + gate are
  // reliably sending before the doctor speaks, since level detection alone isn't a dependable
  // "audio is really going out" signal. This is the 2-3s the user asked for.
  let micOnAt = 0;
  const MIC_ARM_MS = 2500;
  let desiredMicOn = false;
  let currentEvents: VideoTransportEvents | null = null;
  const conversationId = (() => {
    try { return new URL(opts.conversationUrl).pathname.split("/").filter(Boolean).pop() || ""; } catch { return ""; }
  })();
  const dailyAudioLive = () => {
    try { return call?.localAudio() === true; } catch { return false; }
  };
  // "Capturing" = audio is ACTUALLY flowing to Tavus, not just the track toggled on. The UI's green
  // "mic on" reflects THIS, so the doctor waits through the warm-up (amber) instead of speaking into a
  // mic that isn't sending yet — the "first few seconds get dropped" bug. Needs: mic desired-on, the
  // track live, a level frame observed since turn-on (the track is producing), and — with the silent
  // gate — the AudioContext running (it starts SUSPENDED until a user gesture resumes it, during which
  // the gated track is pure silence even with the gain open).
  const capturing = () => {
    if (!desiredMicOn || !dailyAudioLive() || !micLevelSeen) return false;
    if (Date.now() - micOnAt < MIC_ARM_MS) return false; // deliberate warm-up window (amber shows until it elapses)
    return usingSilentGate ? micGateCtx?.state === "running" : true;
  };
  const emitMicState = (reason: string, level?: number) => {
    currentEvents?.onMicState?.({ desired: desiredMicOn, localAudio: capturing(), reason, ...(typeof level === "number" ? { level } : {}) });
  };
  const ensureLocalLevelObserver = () => {
    try {
      if (!call?.startLocalAudioLevelObserver || call.isLocalAudioLevelObserverRunning?.()) return;
      void call.startLocalAudioLevelObserver(100).catch(() => undefined);
    } catch {
      /* observer is diagnostics only */
    }
  };
  const sendInterrupt = (): boolean => {
    if (!call) return false;
    try {
      call.sendAppMessage({ message_type: "conversation", event_type: "conversation.interrupt", conversation_id: conversationId }, "*");
      return true;
    } catch {
      return false;
    }
  };

  return {
    async join(events: VideoTransportEvents): Promise<void> {
      currentEvents = events;
      const Daily = (await import("@daily-co/daily-js")).default;
      // Daily allows ONE call object per page. A previous call whose async destroy hasn't
      // finished (closing and reopening the video quickly, a hot reload, an errored start)
      // otherwise throws "Duplicate DailyIframe instances are not allowed".
      const existing = (Daily as unknown as { getCallInstance?: () => CallObj | null }).getCallInstance?.();
      if (existing) {
        try { await existing.destroy(); } catch { /* already gone */ }
      }
      // Doctor mic starts OFF but must become live immediately when the red mic button is clicked.
      // Pre-acquire the local audio track and give it to Daily, then join muted. That avoids the
      // click-and-speak race where Daily is still creating the sender while the HCP's first words
      // are already gone. The track is not sent until setLocalAudio(true).
      try {
        rawMicStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        const rawTrack = rawMicStream.getAudioTracks()[0] ?? null;
        const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (rawMicStream && rawTrack && AudioContextCtor) {
          micGateCtx = new AudioContextCtor();
          const src = micGateCtx.createMediaStreamSource(rawMicStream);
          const gate = micGateCtx.createGain();
          gate.gain.value = 0;
          const dest = micGateCtx.createMediaStreamDestination();
          src.connect(gate);
          gate.connect(dest);
          micGate = gate;
          gatedMicTrack = dest.stream.getAudioTracks()[0] ?? null;
          usingSilentGate = Boolean(gatedMicTrack);
          localMicTrack = gatedMicTrack ?? rawTrack;
        } else {
          localMicTrack = rawTrack;
        }
      } catch {
        rawMicStream = null;
        localMicTrack = null;
      }
      call = Daily.createCallObject({
        audioSource: localMicTrack ?? true,
        videoSource: false,
        // With a gated mic, Daily stays audio-on but receives digital silence while
        // the UI is red/off. Opening the gate is instant, so the first syllable after
        // a click is not lost to Daily's setLocalAudio warm-up.
        startAudioOff: !usingSilentGate,
      }) as unknown as CallObj;
      emitMicState("call_object_created");
      call.on("track-started", (raw) => {
        const ev = raw as { participant?: { local?: boolean }; track?: MediaStreamTrack };
        if (ev?.participant?.local || !ev?.track) return;
        const kind = ev.track.kind === "video" ? "video" : ev.track.kind === "audio" ? "audio" : null;
        if (kind) events.onTrack(kind, new MediaStream([ev.track]));
      });
      call.on("app-message", (raw) => {
        const p = (raw as { data?: { event_type?: unknown; properties?: { role?: unknown; speech?: unknown; text?: unknown } } })?.data;
        const props = p?.properties ?? {};
        events.onRawEvent?.({
          type: String(p?.event_type ?? ""),
          role: String(props.role ?? ""),
          // FULL text — the replica's streaming transcript is how the deck knows the rep has
          // reached the slide cue, and that cue usually sits near the END of the answer. Truncating
          // here (was 80 chars) hid every late cue, so the deck only ever switched on the early
          // safety timer — the "switched long before the cue / never switched" bug. The consumer
          // bounds what it STORES for QA; detection needs the whole utterance.
          text: String(props.speech ?? props.text ?? ""),
        });
        if (p?.event_type !== "conversation.utterance") return;
        const text = String(props.speech ?? props.text ?? "").trim();
        if (!text) return;
        // Tavus role vocabulary → canonical speakers. "replica" never leaves this file.
        const role = String(props.role ?? "").toLowerCase();
        const speaker = role.includes("replica") ? "rep" : role.includes("user") ? "hcp" : null;
        if (speaker) events.onUtterance({ speaker, text });
      });
      call.on("participant-updated", (raw) => {
        const ev = raw as { participant?: { local?: boolean } };
        if (ev?.participant?.local) emitMicState("participant_updated");
      });
      call.on("local-audio-level", (raw) => {
        const ev = raw as { audioLevel?: number; audio_level?: number; level?: number };
        const level = Number(ev.audioLevel ?? ev.audio_level ?? ev.level ?? 0);
        // A level frame while the mic is on = the track is producing audio → capture confirmed.
        if (desiredMicOn) { micLevelSeen = true; emitMicState("local_audio_level", Number.isFinite(level) ? level : 0); }
      });
      await call.join({ url: opts.conversationUrl, ...(opts.token ? { token: opts.token } : {}) });
      try { call.setLocalAudio(usingSilentGate, { forceDiscardTrack: false }); } catch { /* keep default mic-off best-effort */ }
      // Start the level observer + nudge the gate's AudioContext toward running now (join follows the
      // "Video rep" click, so we're still near a user gesture) — shortens the first-click warm-up.
      if (usingSilentGate) { ensureLocalLevelObserver(); void micGateCtx?.resume().catch(() => undefined); }
      emitMicState(usingSilentGate ? "join_silent_gate" : "join_muted");
    },

    speak(text: string, bargeIn = true): boolean {
      const t = (text || "").trim();
      if (!call || !t) return false;
      const c = call;
      const echo = () => {
        try { c.sendAppMessage({ message_type: "conversation", event_type: "conversation.echo", conversation_id: conversationId, properties: { text: t } }, "*"); } catch { /* not connected */ }
      };
      // Pure echo (no interrupt) — used for the opening greeting: nothing is speaking yet, and a
      // stray interrupt around join is exactly what disrupts Tavus's turn-taking.
      if (!bargeIn) { echo(); return true; }
      try {
        // Gently stop any in-progress speech, then a short natural beat before the new answer.
        sendInterrupt();
        setTimeout(echo, 220);
      } catch { echo(); }
      return true;
    },

    respond(text: string, interrupt = false): boolean {
      const t = (text || "").trim();
      if (!call || !t) return false;
      const c = call;
      const respond = () => {
        try {
          c.sendAppMessage({
            message_type: "conversation",
            event_type: "conversation.respond",
            conversation_id: conversationId,
            properties: { text: t },
          }, "*");
        } catch {
          /* not connected */
        }
      };
      if (!interrupt) {
        respond();
        return true;
      }
      try {
        // For typed barge-in, stop an in-progress answer and let Tavus process the text as if the
        // doctor had just spoken it. Idle typed turns skip this interrupt entirely; sending a stop
        // command when nothing is speaking can reset Tavus turn-taking and add avoidable latency.
        sendInterrupt();
        setTimeout(respond, 90);
      } catch {
        respond();
      }
      return true;
    },

    stopAgentSpeech(): boolean {
      return sendInterrupt();
    },

    setMicEnabled(on: boolean): boolean {
      desiredMicOn = on;
      if (on) { micLevelSeen = false; micOnAt = Date.now(); } // re-confirm capture + restart the warm-up window
      const c = call;
      if (!c) {
        emitMicState(on ? "set_before_join" : "off_before_join");
        return false;
      }
      const apply = (reason: string) => {
        try {
          if (usingSilentGate) {
            // Resume the (suspended-at-join) gate context on this click, and re-emit once it's RUNNING
            // so the UI flips from "starting" (amber) to "on" (green) exactly when audio can flow.
            if (on) micGateCtx?.resume().then(() => emitMicState("gate_ctx_resumed")).catch(() => undefined);
            if (micGate && micGateCtx) micGate.gain.setValueAtTime(on ? 1 : 0, micGateCtx.currentTime);
            // Keep the WebRTC sender hot. The gate, not Daily mute, is the user-facing mic state.
            c.setLocalAudio(true, { forceDiscardTrack: false });
          } else {
            c.setLocalAudio(on, { forceDiscardTrack: false });
          }
          if (on) ensureLocalLevelObserver();
        } catch {
          /* not connected */
        }
        emitMicState(reason);
      };
      apply(on ? "set_local_audio_on" : "set_local_audio_off");
      if (on) {
        // Retry until the TRACK is live (dailyAudioLive), not until fully capturing — capture is
        // confirmed separately by the level observer + resumed context (see capturing()).
        for (const delay of [80, 220, 520, 950]) {
          window.setTimeout(() => {
            if (!call || !desiredMicOn || dailyAudioLive()) return;
            apply(`set_local_audio_on_retry_${delay}`);
          }, delay);
        }
        // Fallback so the mic still confirms "on" (green) on a browser without the level observer:
        // if the track is live (+ gate running) but no level frame arrived, treat it as producing.
        window.setTimeout(() => {
          if (call && desiredMicOn && !micLevelSeen && dailyAudioLive() && (!usingSilentGate || micGateCtx?.state === "running")) {
            micLevelSeen = true;
            emitMicState("capture_warmup_fallback");
          }
        }, 1100);
        // Re-emit when the deliberate warm-up window elapses, so the UI flips amber → green exactly
        // then (capturing() gates on MIC_ARM_MS). +80ms so the window has definitely passed.
        window.setTimeout(() => { if (call && desiredMicOn) emitMicState("mic_arm_window_done"); }, MIC_ARM_MS + 80);
      }
      return capturing();
    },

    leave(): void {
      // destroy() is async — the join-side singleton guard handles a fast re-open racing it.
      const c = call;
      if (c) {
        try { c.stopLocalAudioLevelObserver?.(); } catch { /* noop */ }
        try { c.leave(); void c.destroy(); } catch { /* noop */ }
      }
      call = null;
      currentEvents = null;
      desiredMicOn = false;
      try { gatedMicTrack?.stop(); } catch { /* noop */ }
      try { rawMicStream?.getTracks().forEach((track) => track.stop()); } catch { /* noop */ }
      try { void micGateCtx?.close(); } catch { /* noop */ }
      rawMicStream = null;
      gatedMicTrack = null;
      micGateCtx = null;
      micGate = null;
      usingSilentGate = false;
      localMicTrack = null;
    },
  };
}

/** Registry: provider name (from the conversation-start response) → transport. */
const TRANSPORTS: Record<string, (opts: TransportOptions) => VideoCallTransport> = {
  tavus: createTavusCviTransport,
};

export function createVideoTransport(provider: string, opts: TransportOptions): VideoCallTransport | null {
  const factory = TRANSPORTS[provider];
  return factory ? factory(opts) : null;
}
