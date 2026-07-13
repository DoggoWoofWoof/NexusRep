"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState } from "./NexusRepApp";
import { createRecognizer, setSpeechLanguage, speechVoiceHint, toneSpeechOpts, OpenAiVoiceProvider, type ClientRecognizer, type ClientVoiceProvider } from "@lib/browser-speech";
import { LiveAvatar, type LiveAvatarHandle } from "../_components/LiveAvatar";
import { VideoAgentStage, type VideoAgentStageHandle } from "../_components/VideoAgentStage";
import { SlideView } from "../_components/SlideView";
import { useBrand } from "../_components/useBrand";
import { isOverviewPrompt } from "./overviewPrompt";

// The server's approved-content pipeline chooses the slide. The transcript text only nudges
// timing a little so the deck moves like a presenter, not as a brittle keyword trigger.
const SLIDE_CUE_DELAY_MS = 850;

type HcpScreen = "invite" | "convo" | "complete";
interface Msg { role: "hcp" | "rep"; text: string }
interface OverviewSegment { response: string; detailAidSlideId?: string | null; sourceIds?: string[]; isiDelivered?: boolean }

export function HcpExperience({ app }: { app?: AppState }) {
  const brand = useBrand();
  const tryQuestions = brand?.tryQuestions ?? [];
  const displayName = brand?.displayName ?? "this therapy";
  const tagline = brand?.tagline ?? "";
  const [scr, setScr] = useState<HcpScreen>("invite");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [threeD, setThreeD] = useState(false);
  // Rep voice starts ON; the red "Rep voice off" state makes turning it off obvious.
  const [voiceOn, setVoiceOn] = useState(true);
  // Video-call audio state mirrored from the stage (the header button proxies to it —
  // controls must not disappear when the mode changes).
  const [videoMuted, setVideoMuted] = useState(false);
  // The doctor's mic starts OFF in every mode (red = off). Click the mic to talk. Same rule for
  // the live video call and the voice-off chat, so the control never means opposite things.
  const [callMicOn, setCallMicOn] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [deckFocus, setDeckFocus] = useState<string>(""); // "" → SlideView shows the first slide (title)
  const [fs, setFs] = useState(false);
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  // The doctor's identity: the invite link carries it on the shared page (/hcp?hcp=<id>),
  // and the in-app preview passes it via Audience → "Preview AI rep" (app.sessionHcpId).
  // Sent with every request; the server honors it only for a real targeted HCP.
  const [urlHcpId, setUrlHcpId] = useState("");
  const inviteHcpId = app?.sessionHcpId || urlHcpId;

  const voiceRef = useRef<ClientVoiceProvider | null>(null);
  const liveRef = useRef<LiveAvatarHandle | null>(null);
  const videoAgentRef = useRef<VideoAgentStageHandle | null>(null);
  const recRef = useRef<ClientRecognizer | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // This text/voice chat's own reviewable session (video uses the Tavus session).
  const chatSessionRef = useRef<string | null>(null);
  // Pending mid-answer slide switch (cleared if a new question arrives first).
  const slideTimerRef = useRef<number | null>(null);

  // The rep's speech locale (ASR + TTS) follows the brand persona's language.
  useEffect(() => { setSpeechLanguage(brand?.language); }, [brand]);
  useEffect(() => {
    try { setUrlHcpId(new URLSearchParams(window.location.search).get("hcp") ?? ""); } catch { /* no window */ }
    voiceRef.current = new OpenAiVoiceProvider(); // real TTS voice off-video, browser fallback
    void voiceRef.current.warmup();
    const rec = createRecognizer();
    recRef.current = rec;
    setMicSupported(rec.supported());
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => { voiceRef.current?.cancel(); document.removeEventListener("fullscreenchange", onFs); if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current); };
  }, []);

  async function speak(text: string, onStart?: () => void) {
    if (!voiceOn) return;
    setSpeaking(true);
    try {
      // "Whole conversation" scope: the chosen video-off voice is the rep's voice throughout, so we
      // speak via our TTS even when video is on (the face still shows; live Tavus CVI is the one
      // exception it can't override). Otherwise: the video avatar's own voice when video is on, and
      // the chosen video-off voice (or app default) when video is off. onStart fires when audio begins.
      if (brand?.voiceWholeConvo && brand?.voiceId) await voiceRef.current?.speak(text, { voice: brand.voiceId, voiceHint: speechVoiceHint(), onStart, ...toneSpeechOpts(brand?.voiceStyle) });
      else if (threeD && liveRef.current?.isReady()) { onStart?.(); await liveRef.current.speak(text); }
      else await voiceRef.current?.speak(text, { tone: brand?.voiceStyle, voice: brand?.voiceId || undefined, voiceHint: speechVoiceHint(), onStart, ...toneSpeechOpts(brand?.voiceStyle) });
    } finally { setSpeaking(false); }
  }

  // The captions panel IS the transcript — one source of truth, no separate system. A rep turn is
  // shown EXACTLY when the rep speaks it and idempotently: called on the voice's onStart (so the
  // caption lands in sync with the audio, never before it) AND once more after speak() resolves as
  // a safety net (so a TTS hiccup can never drop the line). Consecutive-duplicate guarded, so the
  // two calls collapse to one bubble.
  function showRep(text: string) {
    const t = text.trim();
    if (!t) return;
    setMsgs((m) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const last = m[m.length - 1];
      if (last && last.role === "rep" && norm(last.text) === norm(t)) return m;
      return [...m, { role: "rep", text: t }];
    });
  }

  // One place that delivers a rep turn to the doctor, so every caller (ask / deckStep / overview)
  // behaves identically. Video: the live replica speaks and its utterance drives the caption
  // (syncVideoRepTurn) — synced by construction, never held back. Off-video: the caption + slide
  // appear the MOMENT the gated answer arrives (never gated on the voice — that would slow the
  // transcript), and the voice then starts as soon as it's generated.
  async function deliverRep(text: string, slideId: string | null | undefined, gen: number) {
    if (playGenRef.current !== gen) return; // superseded by a newer turn (barge-in)
    if (videoOn) {
      const queued = videoAgentRef.current?.speak(text, slideId ?? null) ?? false;
      if (!queued && playGenRef.current === gen) {
        // Provider not connected yet: keep the transcript truthful by showing the gated text only
        // when there is no video voice path to carry it.
        showRep(text);
        cueSlide(slideId, text);
      }
      await wait(estimateSpeechMs(text));
      return;
    }
    // Transcript first, immediately — the caption is never delayed to match the voice.
    showRep(text);
    cueSlide(slideId, text);
    // Then speak (kick the audio off the moment the text exists). Awaited so a multi-segment
    // overview still paces one segment after the previous finishes.
    if (voiceOn) await speak(text);
  }

  function slideCueDelay(text?: string): number {
    const body = text?.trim();
    if (!body) return SLIDE_CUE_DELAY_MS;
    const lower = body.toLowerCase();
    const markers = [
      "you can see",
      "you can look",
      "i've pulled up",
      "i have pulled up",
      "take a look",
      "on your screen",
      "on screen",
      "shown on",
      "available on screen",
      "let's move to",
      "we'll start with",
      "i'll use",
      "i’d show",
      "i'd show",
      "i'm showing",
    ];
    const idx = markers
      .map((m) => lower.indexOf(m))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (idx == null) return SLIDE_CUE_DELAY_MS;
    const wordsBefore = body.slice(0, idx).split(/\s+/).filter(Boolean).length;
    return Math.min(1800, Math.max(550, wordsBefore * 125));
  }

  function cueSlide(id?: string | null, spokenText?: string) {
    if (!id) return;
    if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current);
    slideTimerRef.current = window.setTimeout(() => setDeckFocus(id), slideCueDelay(spokenText));
  }

  // The live video rep speaks its own turns (greeting + answers); each spoken utterance the
  // transport reports becomes a caption here, in sync with the voice. Deduped so a re-emitted
  // utterance never doubles a bubble. This is the ONLY writer of rep captions while on video.
  function syncVideoRepTurn(turn: { text: string; detailAidSlideId?: string | null }) {
    const text = turn.text.trim();
    if (!text) return;
    setMsgs((current) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (current.some((m) => m.role === "rep" && norm(m.text) === norm(text))) return current;
      return [...current, { role: "rep", text }];
    });
    cueSlide(turn.detailAidSlideId, text);
  }

  function addSpokenHcpTurn(text: string) {
    const t = text.trim();
    if (!t) return;
    setMsgs((current) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const last = current[current.length - 1];
      if (last?.role === "hcp" && norm(last.text) === norm(t)) return current; // re-emit dedup
      return [...current, { role: "hcp", text: t }];
    });
  }

  // Monotonic playback generation: each new ask bumps it, so an in-flight multi-segment
  // playback (or a long spoken answer) stops deferring to a stale turn. This is what lets
  // the doctor type MID-ANSWER — the send button no longer waits out the speech.
  const playGenRef = useRef(0);
  const finishPending = (gen: number) => {
    if (playGenRef.current === gen) setPending(false);
  };
  function interruptPlayback() {
    playGenRef.current += 1;
    voiceRef.current?.cancel();
    setSpeaking(false);
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text) return;
    // Barge-in: a new question interrupts whatever the rep is still saying.
    const gen = ++playGenRef.current;
    voiceRef.current?.cancel();
    setSpeaking(false);
    setInput("");
    const videoSession = videoOn ? (window as unknown as { __nexusrep?: { sessionId?: string } }).__nexusrep?.sessionId : undefined;
    if (videoOn && !videoSession) {
      setNotice("The video rep is still connecting. Give it a moment, then ask again.");
      return;
    }
    const openNew = !videoOn && !chatSessionRef.current;
    const sessionId = videoSession ?? chatSessionRef.current ?? undefined;
    setPending(true);
    setMsgs((m) => [...m, { role: "hcp", text }]);
    try {
      // Session routing: video → the live Tavus session (its own greeting + turns come via the
      // replica's utterances). Text/voice → this chat's own session, created on the first message.
      // No greeting is sent off-video: the doctor never heard one, so the transcript starts with
      // this question (the greeting is a video-only, Tavus-spoken thing).
      if (isOverviewPrompt(text, { productTerms: brand?.productTerms ?? [] })) {
        const res = await fetch("/api/presentation/overview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, sessionId, newSession: openNew, hcpId: inviteHcpId || undefined }),
        });
        const data = (await res.json()) as { sessionId?: string; segments?: OverviewSegment[] };
        if (playGenRef.current !== gen) return;
        if (!videoOn && data.sessionId) chatSessionRef.current = data.sessionId;
        finishPending(gen); // input is live again — playback below is interruptible
        for (const segment of data.segments ?? []) {
          if (playGenRef.current !== gen) return; // superseded by a newer question
          await deliverRep(segment.response, segment.detailAidSlideId, gen);
        }
        return;
      }
      if (videoOn) {
        const sent = videoAgentRef.current?.respond(text) ?? false;
        finishPending(gen);
        if (!sent) setNotice("The video rep is still connecting. Give it a moment, then ask again.");
        return;
      }
      const res = await fetch("/api/conversation/turn", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, sessionId, newSession: openNew, hcpId: inviteHcpId || undefined }),
      });
      const data = (await res.json()) as { response: string; isiDelivered: boolean; followUp: string | null; detailAid: { title: string; label: string } | null; detailAidSlideId?: string | null; provider: string; latencyMs: number; sessionId?: string };
      if (playGenRef.current !== gen) return;
      if (!videoOn && data.sessionId) chatSessionRef.current = data.sessionId;
      if (data.followUp) setNotice(followUpNotice(data.followUp));
      finishPending(gen); // request is done — the caption appears in sync with the voice below
      // The caption + detail-aid slide land the moment the rep starts speaking (deliverRep), so
      // the transcript never runs ahead of the voice. Superseded turns (barge-in) are dropped.
      void deliverRep(data.response, data.detailAidSlideId, gen);
    } finally { finishPending(gen); }
  }

  async function deckStep(action: "start" | "next" | "previous" | "jump", query?: string, displayText?: string) {
    if (pending) return;
    // Same barge-in as ask(): a deck command interrupts whatever is still being spoken.
    const gen = ++playGenRef.current;
    voiceRef.current?.cancel();
    setSpeaking(false);
    const label = displayText?.trim() || (action === "next" ? "Please keep going." : action === "previous" ? "Can you go back to the prior point?" : action === "jump" && query ? `Can you talk about ${query}?` : "Can you walk me through the approved information?");
    const videoSession = videoOn ? (window as unknown as { __nexusrep?: { sessionId?: string } }).__nexusrep?.sessionId : undefined;
    if (videoOn && !videoSession) {
      setNotice("The video rep is still connecting. Give it a moment, then continue.");
      return;
    }
    const openNew = !videoOn && !chatSessionRef.current;
    const sessionId = videoSession ?? chatSessionRef.current ?? undefined;
    setPending(true);
    setMsgs((m) => [...m, { role: "hcp", text: label }]);
    try {
      const res = await fetch("/api/presentation/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, query, displayText: label, currentSlideId: deckFocus || undefined, sessionId, newSession: openNew, hcpId: inviteHcpId || undefined }),
      });
      const data = (await res.json()) as { response: string; detailAidSlideId?: string | null; sessionId?: string; step?: { index: number; total: number } | null };
      if (playGenRef.current !== gen) return;
      if (!videoOn && data.sessionId) chatSessionRef.current = data.sessionId;
      finishPending(gen);
      void deliverRep(data.response, data.detailAidSlideId, gen);
    } finally {
      finishPending(gen);
    }
  }

  function request(kind: "human" | "msl" | "ae") {
    const m = {
      human: `A representative will reach out — a follow-up was created for the ${displayName} team.`,
      msl: "Connecting you with a Medical Science Liaison. An MSL follow-up has been routed.",
      ae: "Thank you. This has been logged as a potential adverse event and routed to pharmacovigilance.",
    };
    setNotice(m[kind]);
  }

  async function toggleFs() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await rootRef.current?.requestFullscreen(); } catch { /* denied */ }
  }
  function toggleMic() {
    const rec = recRef.current;
    if (!rec || !rec.supported()) return;
    if (listening) { rec.stop(); setListening(false); return; }
    voiceRef.current?.cancel(); setSpeaking(false);
    setListening(true);
    rec.start((text) => { setListening(false); setInput(""); void ask(text); }, () => setListening(false));
  }
  function toggleVideoMode() {
    interruptPlayback();
    setVideoOn((v) => !v);
    setVideoMuted(false);
    setCallMicOn(false);
  }

  const doctorMicOn = videoOn ? callMicOn : listening;
  const doctorMicOff = !doctorMicOn;
  const askBar = (label: string) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(input); }} placeholder={listening ? "Listening…" : videoOn ? "Type, or talk to the rep…" : "Type or tap the mic to talk…"} style={{ flex: 1, padding: "11px 13px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 13px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
      {micSupported && (
        <button
          type="button"
          onClick={() => {
            if (videoOn) { const next = !callMicOn; setCallMicOn(next); videoAgentRef.current?.setMicEnabled(next); }
            else toggleMic();
          }}
          aria-label={doctorMicOn ? "Turn microphone off" : "Turn microphone on"}
          title={doctorMicOn ? "Your microphone is on — click to stop" : "Your microphone is off — click to talk"}
          style={{ padding: "11px 13px", background: doctorMicOff ? "var(--dn-danger)" : "var(--dn-brand-base)", color: "#fff", border: "1px solid var(--dn-border)", borderRadius: 9, fontSize: 15, cursor: "pointer" }}
        >🎤</button>
      )}
      <button onClick={() => void ask(input)} disabled={pending} style={{ padding: "11px 18px", background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" }}>{pending ? "…" : label}</button>
    </div>
  );
  // First-visit help for the doctor — plain language, dismissible, remembered.
  const [hintsOpen, setHintsOpen] = useState(false);
  useEffect(() => {
    try { setHintsOpen(localStorage.getItem("nexusrep_hcp_hints") !== "dismissed"); } catch { setHintsOpen(true); }
  }, []);
  const dismissHints = () => {
    setHintsOpen(false);
    try { localStorage.setItem("nexusrep_hcp_hints", "dismissed"); } catch { /* private mode */ }
  };
  const hintsCard = hintsOpen ? (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderRadius: 10, padding: "10px 12px", marginBottom: 11 }}>
      <div style={{ font: "400 11.5px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)", flex: 1 }}>
        <strong style={{ color: "var(--dn-fg)" }}>How this works:</strong> type a question, or tap <strong>🎤</strong> and speak.
        Turn on <strong>🔊 Rep voice</strong> to hear answers read aloud. <strong>🎥 Video rep</strong> starts a live video
        conversation — end it anytime. The <strong>guided overview</strong> buttons walk you through the slides,
        and you can always request a <strong>human rep</strong>, an <strong>MSL</strong>, or <strong>report a side effect</strong> below.
      </div>
      <span onClick={dismissHints} title="Dismiss" style={{ cursor: "pointer", font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "1px 4px" }}>✕</span>
    </div>
  ) : null;

  const tryChips = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
      <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", alignSelf: "center" }}>Try:</span>
      {tryQuestions.map((q) => <span key={q} onClick={() => void ask(q)} style={{ padding: "7px 11px", background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderRadius: 20, font: "500 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", cursor: "pointer" }}>{q.replace("What's the ", "").replace("Tell me about the ", "").replace(/\?$/, "")}</span>)}
    </div>
  );
  return (
    <div ref={rootRef} style={{ height: "100vh", overflowY: "auto", background: "var(--dn-bg)", fontFamily: "var(--dn-font-sans)", color: "var(--dn-fg)" }}>
      <header style={{ height: 56, background: "#fff", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", padding: "0 24px", gap: 12, position: "sticky", top: 0, zIndex: 10 }}>
        <img src="/assets/docnexus-logo-large.png" alt="" style={{ height: 26 }} />
        <span style={{ font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{displayName} Information Session</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7, font: "600 11px/1 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", padding: "6px 11px", borderRadius: 20 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#f59e0b" }} />AI Representative</span>
          {scr === "convo" && (
            <button onClick={() => void toggleFs()} style={ghostSm}>{fs ? "Exit full screen" : "⛶ Full screen"}</button>
          )}
          <button onClick={() => request("human")} style={ghostSm}>Need help?</button>
          {app && <button onClick={() => app.setMode("brand")} style={{ ...ghostSm, background: "var(--dn-surface-2)", color: "var(--dn-fg-muted)" }}>Exit demo</button>}
        </div>
      </header>

      {scr === "invite" && (
        <div style={{ minHeight: "calc(100vh - 56px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
          <div style={{ maxWidth: 540, width: "100%", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 18, boxShadow: "var(--dn-shadow-medical)", overflow: "hidden" }}>
            <div style={{ background: "var(--dn-gradient-hero, linear-gradient(120deg,#04307a,#2563eb))", padding: "30px 32px", color: "#fff" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,.15)", padding: "6px 11px", borderRadius: 20, font: "600 10.5px/1 var(--dn-font-sans)", marginBottom: 16 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fbbf24" }} />AI-guided · not a person</div>
              <h1 style={{ font: "600 23px/1.25 var(--dn-font-sans)", margin: 0, letterSpacing: "-0.01em" }}>You&apos;re invited to an AI-guided session on {displayName}</h1>
              <p style={{ font: "400 13px/1.55 var(--dn-font-sans)", color: "rgba(255,255,255,.85)", margin: "12px 0 0" }}>A brief, on-demand walkthrough of publicly-disclosed information on {displayName}{tagline ? ` — ${tagline}` : ""} — answer questions at your own pace.</p>
            </div>
            <div style={{ padding: "26px 32px" }}>
              <div style={{ padding: "14px 16px", background: "var(--dn-surface-2)", borderRadius: 11, marginBottom: 22 }}>
                <div style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 8 }}>What to expect</div>
                <div style={{ font: "400 12px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>You&apos;ll talk with an AI representative that shares only publicly-disclosed information about {displayName}.{brand?.investigational ? ` ${displayName} is investigational and not FDA approved —` : ""} the rep routes clinical questions like dosing, efficacy, or safety to Medical Information, and you can ask for a human rep or MSL anytime.</div>
              </div>
              <button onClick={() => { setMsgs([]); setScr("convo"); }} style={{ width: "100%", padding: 14, background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 10, font: "600 14px/1 var(--dn-font-sans)", cursor: "pointer" }}>Start session</button>
            </div>
          </div>
        </div>
      )}

      {scr === "convo" && (
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
          {notice && <Notice text={notice} onClose={() => setNotice("")} />}
          {/* The compliant rep conversation (model testing lives in AI Rep Studio → Training). */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, alignItems: "start" }}>
              {/* LEFT — the rep (live Tavus video OR the 3D/2D avatar) + one ask bar */}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {videoOn
                  ? <VideoAgentStage onMutedChange={setVideoMuted} onHcpUtterance={addSpokenHcpTurn} ref={videoAgentRef} onClose={() => setVideoOn(false)} onRepTurn={syncVideoRepTurn} hcpId={inviteHcpId || undefined} />
                  : <LiveAvatar ref={liveRef} enabled={threeD} speaking={speaking} fallbackStream={null} fallbackStatus={listening ? "Listening…" : speaking ? "Speaking…" : "Ready"} height={300} />}
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "15px 16px", boxShadow: "var(--dn-shadow-card)" }}>{hintsCard}{askBar("Ask")}{tryChips}</div>
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "12px 14px", boxShadow: "var(--dn-shadow-card)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginRight: 2 }}>Guided overview</span>
                  <button onClick={() => void ask(`Can you give me a quick overview of ${displayName}?`)} disabled={pending} style={ghostMd}>Start overview</button>
                  <button onClick={() => void deckStep("previous")} disabled={pending} style={ghostMd}>Go back</button>
                  <button onClick={() => void deckStep("next")} disabled={pending} style={ghostMd}>Continue</button>
                </div>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <button onClick={() => request("human")} style={ghostMd}>Request human rep</button>
                  <button onClick={() => request("msl")} style={ghostMd}>Request MSL</button>
                  <button onClick={() => request("ae")} style={{ ...ghostMd, color: "var(--dn-accent-orange)" }}>Report side effect</button>
                  <button onClick={toggleVideoMode} title="Live video representative (DocNexus Agent)" style={{ ...ghostMd, color: videoOn ? "#fff" : "var(--dn-fg)", background: videoOn ? "var(--dn-brand-base)" : "#fff" }}>{videoOn ? "🎥 Video on" : "🎥 Video rep"}</button>
                  {!videoOn && <button onClick={() => setThreeD((v) => !v)} style={{ ...ghostMd, color: threeD ? "#fff" : "var(--dn-fg)", background: threeD ? "var(--dn-brand-base)" : "#fff" }}>{threeD ? "🧑 3D: on" : "🧑 3D avatar"}</button>}
                  <button
                    onClick={() => {
                      if (videoOn) { videoAgentRef.current?.setMuted(!videoMuted); }
                      else { if (voiceOn) voiceRef.current?.cancel(); setVoiceOn((v) => !v); }
                    }}
                    title={(videoOn ? !videoMuted : voiceOn) ? "The rep reads answers aloud — click to turn its voice off" : "The rep's voice is off — answers aren't read aloud. Click to turn it on."}
                    // Off must LOOK off (red) — and say WHOSE audio this is: the REP's voice
                    // (speaker), never the doctor's mic. "Muted" alone reads as mic-muted.
                    style={{ ...ghostMd, ...((videoOn ? !videoMuted : voiceOn) ? {} : { background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca" }) }}
                  >{(videoOn ? !videoMuted : voiceOn) ? "🔊 Rep voice on" : "🔇 Rep voice off"}</button>
                  <button onClick={() => setScr("complete")} style={{ marginLeft: "auto", padding: "10px 16px", background: "var(--dn-brand-dark)", color: "#fff", border: "none", borderRadius: 9, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer" }}>End session →</button>
                </div>
              </div>
              {/* RIGHT — the approved slides ON TOP, captions BELOW (swapped) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", padding: 14 }}>
                  <div style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 10 }}>On screen now · approved deck</div>
                  <SlideView focusId={deckFocus} compact />
                </div>
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", display: "flex", flexDirection: "column", height: 260 }}>
                  <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--dn-border)", font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Captions</div>
                  <div style={{ flex: 1, overflowY: "auto", padding: "15px 16px", display: "flex", flexDirection: "column", gap: 11 }}>
                    {msgs.length === 0 && <div style={{ textAlign: "center", color: "var(--dn-fg-subtle)", font: "400 12px/1.5 var(--dn-font-sans)", padding: "24px 10px" }}>Ask a question or pick a topic to begin.</div>}
                    {msgs.map((m, i) => (
                      <div key={i} style={{ alignSelf: m.role === "hcp" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
                        <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 4, textAlign: m.role === "hcp" ? "right" : "left" }}>{m.role === "hcp" ? "You" : "AI rep"}</div>
                        <div style={{ padding: "9px 12px", borderRadius: 11, font: "400 12.5px/1.5 var(--dn-font-sans)", whiteSpace: "pre-wrap", background: m.role === "hcp" ? "var(--dn-brand-base)" : "var(--dn-surface-2)", color: m.role === "hcp" ? "#fff" : "var(--dn-fg)", border: m.role === "hcp" ? "none" : "1px solid var(--dn-border)" }}>{m.text}</div>
                      </div>
                    ))}
                    {pending && <div style={{ font: "400 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Checking approved information…</div>}
                  </div>
                </div>
              </div>
            </div>
        </div>
      )}

      {scr === "complete" && (
        <div style={{ minHeight: "calc(100vh - 56px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
          <div style={{ maxWidth: 540, width: "100%", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 18, boxShadow: "var(--dn-shadow-medical)", overflow: "hidden", textAlign: "center", padding: "30px 32px 26px" }}>
            <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--dn-accent-green-bg)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 26, color: "#166534" }}>✓</div>
            <h1 style={{ font: "600 21px/1.25 var(--dn-font-sans)", margin: 0, color: "var(--dn-fg)" }}>Thanks for your time</h1>
            <p style={{ font: "400 13px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "10px 0 20px" }}>Request a follow-up and we&apos;ll send approved {displayName} information or connect you with our team.</p>
            <button onClick={() => { if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current); setScr("invite"); setMsgs([]); setNotice(""); setDeckFocus(""); setVideoOn(false); chatSessionRef.current = null; }} style={{ width: "100%", padding: 12, background: "var(--dn-surface-2)", color: "var(--dn-fg-muted)", border: "1px solid var(--dn-border)", borderRadius: 10, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer" }}>Close session</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16, padding: "12px 16px", background: "#fff", border: "1px solid var(--dn-brand-light)", borderLeft: "4px solid var(--dn-brand-base)", borderRadius: 10, boxShadow: "var(--dn-shadow-card)" }}>
      <span style={{ flexShrink: 0, width: 20, height: 20, borderRadius: "50%", background: "var(--dn-brand-base)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>✓</span>
      <span style={{ flex: 1, font: "500 12.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{text}</span>
      <span onClick={onClose} style={{ font: "600 16px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", cursor: "pointer" }}>×</span>
    </div>
  );
}

function followUpNotice(kind: string): string {
  switch (kind) {
    case "msl": case "medical_information": return "Connecting you with a Medical Science Liaison. An MSL follow-up has been routed.";
    case "pharmacovigilance": return "This has been logged as a potential adverse event and routed to pharmacovigilance.";
    case "human_rep": return "A representative will reach out — a follow-up was created.";
    default: return "A follow-up has been created.";
  }
}

function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(5500, Math.min(28000, words * 360));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const ghostSm: React.CSSProperties = { padding: "8px 13px", background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 8, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer" };
const ghostMd: React.CSSProperties = { padding: "10px 14px", background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer" };
