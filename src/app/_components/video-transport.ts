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
  /** Raw vendor events, for QA visibility only (vendor vocabulary allowed here). */
  onRawEvent?: (e: { type: string; role: string; text: string }) => void;
}

export interface VideoCallTransport {
  /** Connect to the call and start delivering events. */
  join(events: VideoTransportEvents): Promise<void>;
  /** Make the agent speak our (already gated) text verbatim. False if not connected. */
  speak(text: string): boolean;
  /** Send typed doctor text into the PAL as user input, so Tavus runs its fast response path. */
  respond(text: string): boolean;
  /** Enable/disable the doctor's microphone on the call (push-to-mute). */
  setMicEnabled(on: boolean): void;
  leave(): void;
}

interface TransportOptions {
  conversationUrl: string;
  token?: string | null;
}

/**
 * Tavus CVI transport: a Daily/WebRTC room plus Tavus "conversation.*" app-messages.
 * The interrupt-then-echo beat makes a barge-in read like a person pausing to pick
 * up the new question rather than an abrupt splice. This file is the ONLY client
 * code that knows Tavus's protocol (echo/interrupt/utterance, the "replica" role).
 */
function createTavusCviTransport(opts: TransportOptions): VideoCallTransport {
  type CallObj = {
    join: (o: { url: string; token?: string }) => Promise<unknown>;
    leave: () => void;
    destroy: () => Promise<void> | void;
    setLocalAudio: (on: boolean) => void;
    sendAppMessage: (data: unknown, to?: string) => void;
    on: (event: string, cb: (ev: unknown) => void) => void;
  };
  let call: CallObj | null = null;
  const conversationId = (() => {
    try { return new URL(opts.conversationUrl).pathname.split("/").filter(Boolean).pop() || ""; } catch { return ""; }
  })();

  return {
    async join(events: VideoTransportEvents): Promise<void> {
      const Daily = (await import("@daily-co/daily-js")).default;
      // Daily allows ONE call object per page. A previous call whose async destroy hasn't
      // finished (closing and reopening the video quickly, a hot reload, an errored start)
      // otherwise throws "Duplicate DailyIframe instances are not allowed".
      const existing = (Daily as unknown as { getCallInstance?: () => CallObj | null }).getCallInstance?.();
      if (existing) {
        try { await existing.destroy(); } catch { /* already gone */ }
      }
      // Doctor mic starts OFF but must be re-enableable by the red mic button. We ACQUIRE the mic
      // (audioSource:true) yet JOIN MUTED (setLocalAudio(false) below) — so clicking the mic simply
      // unmutes an existing track. Creating with audioSource:false leaves NO track, and then
      // setLocalAudio(true) can't turn the mic on at all (the doctor's voice never reaches Tavus →
      // no ASR, no turn, no logs — the "voice mode doesn't work" regression).
      call = Daily.createCallObject({ audioSource: true, videoSource: false }) as unknown as CallObj;
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
          text: String(props.speech ?? props.text ?? "").slice(0, 80),
        });
        if (p?.event_type !== "conversation.utterance") return;
        const text = String(props.speech ?? props.text ?? "").trim();
        if (!text) return;
        // Tavus role vocabulary → canonical speakers. "replica" never leaves this file.
        const role = String(props.role ?? "").toLowerCase();
        const speaker = role.includes("replica") ? "rep" : role.includes("user") ? "hcp" : null;
        if (speaker) events.onUtterance({ speaker, text });
      });
      await call.join({ url: opts.conversationUrl, ...(opts.token ? { token: opts.token } : {}) });
      try { call.setLocalAudio(false); } catch { /* keep default mic-off best-effort */ }
    },

    speak(text: string): boolean {
      const t = (text || "").trim();
      if (!call || !t) return false;
      const c = call;
      const echo = () => {
        try { c.sendAppMessage({ message_type: "conversation", event_type: "conversation.echo", conversation_id: conversationId, properties: { text: t } }, "*"); } catch { /* not connected */ }
      };
      try {
        // Gently stop any in-progress speech, then a short natural beat before the new answer.
        c.sendAppMessage({ message_type: "conversation", event_type: "conversation.interrupt", conversation_id: conversationId }, "*");
        setTimeout(echo, 220);
      } catch { echo(); }
      return true;
    },

    respond(text: string): boolean {
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
      try {
        // For typed barge-in, stop any in-progress answer and let Tavus process the text
        // as if the doctor had just spoken it. This avoids the slow app-fetch-then-echo path.
        c.sendAppMessage({ message_type: "conversation", event_type: "conversation.interrupt", conversation_id: conversationId }, "*");
        setTimeout(respond, 90);
      } catch {
        respond();
      }
      return true;
    },

    setMicEnabled(on: boolean): void {
      try { call?.setLocalAudio(on); } catch { /* not connected */ }
    },

    leave(): void {
      // destroy() is async — the join-side singleton guard handles a fast re-open racing it.
      if (call) { try { call.leave(); void call.destroy(); } catch { /* noop */ } }
      call = null;
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
