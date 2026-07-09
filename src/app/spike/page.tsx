"use client";

/**
 * Stage 2 — A/V rehearsal, now with REAL browser-native audio/video.
 * The approved script comes from the server (approved content); the client
 * speaks each line aloud for real via SpeechSynthesis (BrowserVoiceProvider),
 * animates the avatar while speaking, displays the detail aid, and can show the
 * real webcam. No vendor keys. If a device has no installed voices (e.g. CI),
 * playback falls back to real-time pacing so the flow still works.
 */

import { useRef, useState } from "react";
import type { SpikeEvent, SpikeTimeline } from "@modules/realtime";
import { BrowserVoiceProvider } from "@lib/browser-speech";
import { LiveAvatar, type LiveAvatarHandle } from "../_components/LiveAvatar";
import { useBrand } from "../_components/useBrand";

type Phase = "idle" | "running" | "ended";

export default function AvSpikePage() {
  const brand = useBrand();
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState<{ text: string; sourceId?: string }[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [slideId, setSlideId] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [engine, setEngine] = useState<string>("");
  const [threeD, setThreeD] = useState(false);
  const runningRef = useRef(false);
  const voiceRef = useRef<BrowserVoiceProvider | null>(null);
  const liveRef = useRef<LiveAvatarHandle | null>(null);

  async function toggleCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      setStream(s);
    } catch {
      alert("Camera unavailable or permission denied.");
    }
  }

  async function start() {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("running");
    setTranscript([]);
    setSlideId(null);

    const voice = voiceRef.current ?? new BrowserVoiceProvider();
    voiceRef.current = voice;
    await voice.warmup();
    setEngine(
      threeD && liveRef.current?.isReady()
        ? "live 3D avatar + neural voice"
        : voice.audioAvailable()
          ? "real voice"
          : "simulated (no installed voices)",
    );

    const res = await fetch("/api/spike/run", { method: "POST" });
    const timeline = (await res.json()) as SpikeTimeline;

    for (const ev of timeline.events) {
      await playEvent(ev, voice);
    }
    setSpeaking(false);
    setPhase("ended");
    runningRef.current = false;
  }

  async function playEvent(ev: SpikeEvent, voice: BrowserVoiceProvider) {
    if (ev.kind === "speak") {
      const text = ev.text ?? "";
      setTranscript((t) => [...t, { text, sourceId: ev.sourceId }]);
      setSpeaking(true);
      if (threeD && liveRef.current?.isReady()) {
        await liveRef.current.speak(text); // 3D avatar + neural voice
      } else {
        await voice.speak(text, { voiceHint: "en", rate: 1 }); // browser voice
      }
      setSpeaking(false);
    } else if (ev.kind === "detail_aid") {
      setSlideId(ev.slideId ?? null);
    }
  }

  // Slide labels come from the active brand's deck (brand-agnostic), not a hardcoded map.
  const deckSlide = slideId ? brand?.deck.find((s) => s.id === slideId) : null;
  const slide = deckSlide ? { title: deckSlide.title, body: deckSlide.subtitle ?? deckSlide.bullets?.[0] ?? "" } : null;
  const status = phase === "idle" ? "Ready" : speaking ? "Speaking…" : phase === "ended" ? "Session ended" : "…";

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px 64px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--dn-brand-light)" }}>
        AI Rep Studio · Train
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: "6px 0 4px" }}>Rehearsal — live A/V</h1>
      <p style={{ color: "var(--dn-fg-muted)", margin: "0 0 20px" }}>
        Approved script spoken aloud for real (browser voice), with the detail aid and an optional live camera.
        A premium voice or synthetic avatar plugs in here once a vendor key is added.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start" }}>
        <div>
          <LiveAvatar
            ref={liveRef}
            enabled={threeD}
            speaking={speaking}
            fallbackStream={stream}
            fallbackStatus={status}
          />
          <div
            aria-label="Detail aid"
            style={{ marginTop: 12, minHeight: 92, borderRadius: "var(--dn-radius-lg)", border: "1px solid var(--dn-border)", background: "var(--dn-surface)", padding: 16 }}
          >
            {slide ? (
              <>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{slide.title}</div>
                <div style={{ fontSize: 13, color: "var(--dn-fg-muted)" }}>{slide.body}</div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "var(--dn-fg-subtle)" }}>Detail aid appears here during the detail.</div>
            )}
          </div>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Transcript</div>
            <button
              onClick={() => setThreeD((v) => !v)}
              disabled={phase === "running"}
              title="Loads a 3D avatar + free neural voice (Chrome + WebGPU; first load downloads the voice model)"
              style={{ padding: "8px 12px", background: threeD ? "var(--dn-brand-base)" : "var(--dn-surface)", color: threeD ? "#fff" : "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: "var(--dn-radius-md)", fontSize: 12, fontWeight: 600, cursor: phase === "running" ? "default" : "pointer" }}
            >
              {threeD ? "Live 3D: on" : "Live 3D: off"}
            </button>
            <button
              onClick={toggleCamera}
              style={{ padding: "8px 12px", background: "var(--dn-surface)", border: "1px solid var(--dn-border)", borderRadius: "var(--dn-radius-md)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              {stream ? "Stop camera" : "Use camera"}
            </button>
            <button
              onClick={start}
              disabled={phase === "running"}
              style={{ padding: "9px 16px", background: phase === "running" ? "var(--dn-border-strong)" : "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: "var(--dn-radius-md)", fontWeight: 600, fontSize: 13, cursor: phase === "running" ? "default" : "pointer" }}
            >
              {phase === "idle" ? "Start rehearsal" : phase === "running" ? "Playing…" : "Restart"}
            </button>
          </div>
          <div style={{ border: "1px solid var(--dn-border)", borderRadius: "var(--dn-radius-lg)", background: "var(--dn-surface)", padding: 12, minHeight: 240, display: "grid", gap: 8, alignContent: "start" }}>
            {transcript.length === 0 && <div style={{ fontSize: 13, color: "var(--dn-fg-subtle)" }}>Press “Start rehearsal”. Your browser will speak the approved script aloud.</div>}
            {transcript.map((line, i) => (
              <div key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ color: "var(--dn-brand-base)", fontWeight: 600 }}>AI rep: </span>
                {line.text}
                {line.sourceId && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--dn-fg-subtle)" }}>· {line.sourceId}</span>}
              </div>
            ))}
            {phase === "ended" && (
              <div data-testid="spike-ended" style={{ marginTop: 6, fontSize: 12, color: "var(--dn-success)", fontWeight: 600 }}>
                Session ended{engine ? ` · ${engine}` : ""}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
