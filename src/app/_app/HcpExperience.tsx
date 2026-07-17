"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState } from "./NexusRepApp";
import { createRecognizer, setSpeechLanguage, speechVoiceHint, toneSpeechOpts, OpenAiVoiceProvider, type ClientRecognizer, type ClientVoiceProvider } from "@lib/browser-speech";
import { correctHcpAsrBestAlternative } from "@lib/asr-correct";
import { startBargeInVad, type BargeController } from "@lib/barge-vad";
import { LiveAvatar, type LiveAvatarHandle } from "../_components/LiveAvatar";
import { VideoAgentStage, type VideoAgentStageHandle } from "../_components/VideoAgentStage";
import { SlideView } from "../_components/SlideView";
import { useBrand } from "../_components/useBrand";
import { isOverviewPrompt } from "@modules/content/overviewPrompt";
import { appendTurn, type TranscriptMsg } from "@lib/transcript";
import { useCuedSlide } from "../_components/useCuedSlide";
import { isSameLiveTurnText } from "@lib/live-turn-guard";
import { installActivityCapture } from "@lib/activity-client";

// Wall-clock read behind a tiny indirection. These timestamps are for ASR-latency telemetry in
// DEFERRED handlers (mic tap, recognizer callbacks) — never during render — but a bare Date.now()
// in a component-scope function trips the React Compiler's purity lint. The helper keeps it happy
// without a blanket disable, and reads honestly as "get the current time".
const nowMs = () => Date.now();

type HcpScreen = "invite" | "convo" | "complete";
type Msg = TranscriptMsg;

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
  const [videoMicReady, setVideoMicReady] = useState(false);
  const [videoMicActive, setVideoMicActive] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [videoSession, setVideoSession] = useState<{ sessionId: string | null; conversationUrl: string | null } | null>(null);
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
  const bargeRef = useRef<BargeController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // This text/voice chat's own reviewable session (video uses the Tavus session).
  const chatSessionRef = useRef<string | null>(null);
  const videoSessionRef = useRef<{ sessionId: string | null; conversationUrl: string | null } | null>(null);
  const lastSpokenHcpRef = useRef<{ text: string; at: number } | null>(null);
  const suppressNextMicClickRef = useRef(false);
  // Detail-aid slide switching timed to WHEN the rep speaks the cue. On video the timer is anchored
  // to the replica's audio-start (onRepAudioStart → VideoAgentStage), then counts the cue offset;
  // off-video it anchors to when we start the TTS. Backend decides WHETHER (only a cued answer).
  const { cueSlide, onRepAudioStart, cancel: cancelSlideCue } = useCuedSlide(setDeckFocus);

  function setActiveVideoSession(session: { sessionId: string | null; conversationUrl: string | null } | null) {
    videoSessionRef.current = session;
    setVideoSession(session);
  }

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
    // Capture the doctor's clicks / API calls into the activity monitor (the admin sees HCP-side
    // activity too, tagged surface "doctor"). Server-side session/video events carry the sessionId.
    const stopCapture = installActivityCapture({ surface: "doctor" });
    return () => { voiceRef.current?.cancel(); document.removeEventListener("fullscreenchange", onFs); cancelSlideCue(); stopCapture(); };
  }, []);

  async function speak(text: string) {
    if (!voiceOn) return;
    setSpeaking(true);
    try {
      // "Whole conversation" scope: the chosen video-off voice is the rep's voice throughout, so we
      // speak via our TTS even when video is on (the face still shows; live Tavus CVI is the one
      // exception it can't override). Otherwise: the video avatar's own voice when video is on, and
      // the chosen video-off voice (or app default) when video is off.
      if (brand?.voiceWholeConvo && brand?.voiceId) await voiceRef.current?.speak(text, { voice: brand.voiceId, voiceHint: speechVoiceHint(), ...toneSpeechOpts(brand?.voiceStyle) });
      else if (threeD && liveRef.current?.isReady()) await liveRef.current.speak(text);
      else await voiceRef.current?.speak(text, { tone: brand?.voiceStyle, voice: brand?.voiceId || undefined, voiceHint: speechVoiceHint(), ...toneSpeechOpts(brand?.voiceStyle) });
    } finally { setSpeaking(false); }
  }

  // The captions panel IS the transcript — one source of truth, no separate system. A rep turn is
  // appended as soon as the gated answer arrives (never held back to match the voice). Guarded
  // against a consecutive duplicate so it can't double a bubble if called more than once.
  function showRep(text: string) {
    setMsgs((m) => appendTurn(m, "rep", text));
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
        cueSlide(slideId, text, true);
      }
      await wait(estimateSpeechMs(text));
      return;
    }
    // Transcript first, immediately — the caption is never delayed to match the voice.
    showRep(text);
    if (voiceOn) cueSlide(slideId, text, false);
    else {
      cancelSlideCue();
      if (slideId) setDeckFocus(slideId);
    }
    // Then speak (kick the audio off the moment the text exists). Awaited so a multi-segment
    // overview still paces one segment after the previous finishes.
    if (voiceOn) await speak(text);
  }

  // The live video rep speaks its own turns (greeting + answers); each spoken utterance the
  // transport reports becomes a caption here, in sync with the voice. Deduped so a re-emitted
  // utterance never doubles a bubble. This is the ONLY writer of rep captions while on video.
  function syncVideoRepTurn(turn: { text: string; detailAidSlideId?: string | null }) {
    const text = turn.text.trim();
    if (!text) return;
    // appendTurn drops only a consecutive re-emit — NOT an answer that merely repeats one given
    // earlier (a follow-up legitimately re-uses the same approved text). The old all-messages check
    // here is what silently ate repeated turns, leaving the rep bubble missing from the transcript.
    setMsgs((current) => appendTurn(current, "rep", text));
    cueSlide(turn.detailAidSlideId, text, true);
  }

  function correctSpokenHcpText(text: string): string {
    // Snap the video rep's STT (Tavus) mis-hearings of the drug/program names to their canonical
    // spelling before they hit the transcript — same corrector the off-video mic uses.
    const { text: corrected } = correctHcpAsrBestAlternative([text], brand?.hotwords ?? [], brand?.productTerms ?? []);
    return corrected || text;
  }

  function isShortHcpTail(text: string): boolean {
    const words = text.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 3 && /^[a-z0-9\s,.?!-]+$/i.test(text.trim());
  }

  function isOpenHcpFragment(text: string): boolean {
    const t = text.trim();
    return /[,;:–-]\s*$/.test(t) || (/^(?:what|how|tell|explain|can|could|does|is)\b/i.test(t) && !/[?!.]\s*$/.test(t));
  }

  function mergeHcpFragments(head: string, tail: string): string {
    return correctSpokenHcpText(`${head.replace(/[\s,;:–-]+$/g, "")} ${tail.trim()}`)
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  function addSpokenHcpTurn(text: string) {
    const finalText = correctSpokenHcpText(text);
    const now = nowMs();
    const last = lastSpokenHcpRef.current;
    if (last && now - last.at < 22_000 && isSameLiveTurnText(last.text, finalText)) return;
    if (last && now - last.at < 3_000 && isShortHcpTail(finalText) && isOpenHcpFragment(last.text)) {
      const merged = mergeHcpFragments(last.text, finalText);
      lastSpokenHcpRef.current = { text: merged, at: now };
      setMsgs((current) => {
        const idx = (() => {
          for (let i = current.length - 1; i >= 0; i -= 1) {
            if (current[i]!.role === "hcp" && current[i]!.text === last.text) return i;
          }
          return -1;
        })();
        if (idx < 0) return appendTurn(current, "hcp", merged);
        const next = [...current];
        next[idx] = { role: "hcp", text: merged };
        return next;
      });
      return;
    }
    lastSpokenHcpRef.current = { text: finalText, at: now };
    setMsgs((current) => (
      current.slice(-6).some((m) => m.role === "hcp" && isSameLiveTurnText(m.text, finalText))
        ? current
        : appendTurn(current, "hcp", finalText)
    ));
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
    cancelSlideCue();
    setSpeaking(false);
  }

  async function ask(q: string) {
    const text = correctSpokenHcpText(q.trim());
    if (!text) return;
    // Barge-in: a new question interrupts whatever the rep is still saying.
    const gen = ++playGenRef.current;
    voiceRef.current?.cancel();
    cancelSlideCue();
    setSpeaking(false);
    setInput("");
    const activeVideoSession = videoOn ? videoSessionRef.current : null;
    const videoSessionId = activeVideoSession?.sessionId || undefined;
    if (videoOn && !videoSessionId) {
      setNotice("The video rep is still connecting. Give it a moment, then ask again.");
      return;
    }
    const openNew = !videoOn && !chatSessionRef.current;
    const sessionId = videoSessionId ?? chatSessionRef.current ?? undefined;
    setPending(true);
    try {
      // "Go over the slides" starts the GUIDED DECK at the FIRST slide and STOPS — the doctor then
      // steps through with Continue / Go back (deckStep). No auto-walk: the rep presents ONE slide at
      // a time, so the video never breezes through the whole deck. Same on video and off-video
      // (runDeckStep → deliverRep). Position is tracked via deckFocus, so Continue never restarts.
      if (isOverviewPrompt(text, { productTerms: brand?.productTerms ?? [] })) {
        await runDeckStep("start", undefined, text, gen);
        return;
      }
      // Session routing: video → the live Tavus session (its own greeting + turns come via the
      // replica's utterances). Text/voice → this chat's own session, created on the first message.
      // No greeting is sent off-video: the doctor never heard one, so the transcript starts with
      // this question (the greeting is a video-only, Tavus-spoken thing).
      if (videoOn) {
        const sent = videoAgentRef.current?.respond(text) ?? false;
        if (!sent) {
          setNotice("The video rep is still connecting. Give it a moment, then ask again.");
          return;
        }
        const at = new Date(nowMs()).toISOString();
        lastSpokenHcpRef.current = { text, at: nowMs() };
        setMsgs((m) => [...m, { role: "hcp", text }]);
        // Send the live turn to Tavus immediately. Transcript persistence is a background
        // best-effort timestamp anchor; the custom LLM endpoint still records the authoritative
        // compliant HCP+rep turn, and it reuses this click-time HCP row when the write wins the race.
        void fetch("/api/sessions/utterance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: videoSessionId, speaker: "hcp", text, at }),
        }).catch(() => undefined);
        finishPending(gen);
        return;
      }
      setMsgs((m) => [...m, { role: "hcp", text }]);
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

  // The one place that fetches a presentation STEP and delivers it. Shared by the deck buttons
  // (deckStep, which adds its own barge-in) and the "start the deck" overview intent in ask() (which
  // reuses ask's gen/pending). Position is tracked via deckFocus → currentSlideId, so next/previous
  // advance from where the deck IS — Continue never restarts from the top.
  async function runDeckStep(action: "start" | "next" | "previous" | "jump", query: string | undefined, label: string, gen: number) {
    const activeVideoSession = videoOn ? videoSessionRef.current : null;
    const videoSessionId = activeVideoSession?.sessionId || undefined;
    if (videoOn && !videoSessionId) {
      setNotice("The video rep is still connecting. Give it a moment, then continue.");
      return;
    }
    const openNew = !videoOn && !chatSessionRef.current;
    const sessionId = videoSessionId ?? chatSessionRef.current ?? undefined;
    setMsgs((m) => [...m, { role: "hcp", text: label }]);
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
  }

  async function deckStep(action: "start" | "next" | "previous" | "jump", query?: string, displayText?: string) {
    if (pending) return;
    // Same barge-in as ask(): a deck command interrupts whatever is still being spoken.
    const gen = ++playGenRef.current;
    voiceRef.current?.cancel();
    cancelSlideCue();
    setSpeaking(false);
    const label = displayText?.trim() || (action === "next" ? "Please keep going." : action === "previous" ? "Can you go back to the prior point?" : action === "jump" && query ? `Can you talk about ${query}?` : "Can you walk me through the approved information?");
    setPending(true);
    try {
      await runDeckStep(action, query, label, gen);
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
    setInput("");
    setListening(true);
    // Correct mis-heard drug/program names against the brand's known terms, and log ASR latency so
    // this off-video path can be A/B'd against the Tavus asrMs with no video credits spent.
    const startedAt = nowMs();
    let lastInterimAt = startedAt;
    rec.start(
      (text, alts) => {
        setListening(false);
        const finalAt = nowMs();
        const { text: corrected, corrections, chosenIndex } = correctHcpAsrBestAlternative(alts?.length ? alts : [text], brand?.hotwords ?? [], brand?.productTerms ?? []);
        const finalText = corrected || text;
        setInput("");
        const payload = {
          kind: "asr" as const,
          engine: rec.onDevice ? "whisper(on-device)" : "web-speech",
          raw: text,
          corrected: finalText,
          corrections,
          altCount: alts?.length ?? 1,
          chosenAlt: chosenIndex,
          listenMs: finalAt - startedAt, // mic tap → final transcript (includes speaking)
          finalizeMs: finalAt - lastInterimAt, // last partial → final (~ turn-detect + finalize)
          onDevice: rec.onDevice ?? false,
        };
        // eslint-disable-next-line no-console
        console.info("[nexusrep-asr]", payload);
        void fetch("/api/metrics/latency", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, question: finalText.slice(0, 60) }) }).catch(() => {});
        void ask(finalText); // corrected phrase → ask
      },
      () => setListening(false), // ended (silence / error) — no dangling "Listening…"
      (interim) => { lastInterimAt = nowMs(); if (interim) setInput(interim); }, // live text + finalize timing
    );
  }
  // Leaving a video preview: capture the recording (idempotent — the End-video button may already
  // have), then prune the session if it was an empty stray preview. Safe from every exit path; the
  // server prune never touches an active/recorded/real-Q&A session.
  async function endVideoSession() {
    const sid = videoSessionRef.current?.sessionId ?? null;
    try { await videoAgentRef.current?.finalizeRecording(); } catch { /* best effort */ }
    try {
      await fetch("/api/sessions/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sid ? { endedSessionId: sid } : {}),
      });
    } catch { /* best effort */ }
  }
  async function toggleVideoMode() {
    if (videoOn) await endVideoSession(); // turning the video OFF → finalize the clip + prune if stray
    interruptPlayback();
    setVideoOn((v) => !v);
    setVideoMuted(false);
    setCallMicOn(false);
    setVideoMicReady(false);
    setVideoMicActive(false);
    setActiveVideoSession(null);
  }

  // Off-video barge-in "like Tavus": while the rep is speaking (browser TTS) and we're not already
  // listening, watch an echo-cancelled mic; if the doctor talks over the rep for a sustained beat,
  // stop the rep and open the recognizer to capture the question — no tap needed. Video uses Tavus's
  // native interruptibility. Only runs once the mic is already granted (no surprise prompt).
  // Placed AFTER interruptPlayback/toggleMic so it references them post-declaration (React Compiler).
  useEffect(() => {
    if (!(speaking && !videoOn && !listening)) return;
    let cancelled = false;
    void startBargeInVad(() => {
      if (cancelled) return;
      bargeRef.current = null;
      interruptPlayback(); // stop the rep's TTS immediately
      toggleMic(); // open the recognizer to capture what the doctor is saying
    }).then((c) => { if (cancelled) c?.stop(); else bargeRef.current = c; });
    return () => { cancelled = true; bargeRef.current?.stop(); bargeRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking, videoOn, listening]);

  function setVideoDoctorMic(on: boolean) {
    setCallMicOn(on);
    if (!on) setVideoMicActive(false);
    videoAgentRef.current?.setMicEnabled(on);
  }

  const doctorMicOn = videoOn ? (callMicOn && videoMicReady && videoMicActive) : listening;
  const doctorMicArming = videoOn && callMicOn && videoMicReady && !videoMicActive;
  const doctorMicOff = !doctorMicOn;
  const doctorMicDisabled = videoOn && !videoMicReady;
  const videoSessionLinked = Boolean(videoSession?.sessionId);
  const askBar = (label: string) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(input); }} placeholder={listening ? "Listening…" : videoOn && !videoSessionLinked ? "Video rep is linking the session…" : videoOn && !videoMicReady ? "Video rep is connecting…" : videoOn ? "Type, or talk to the rep…" : "Type or tap the mic to talk…"} style={{ flex: 1, padding: "11px 13px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 13px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
      {(videoOn || micSupported) && (
        <button
          type="button"
          onPointerDown={() => {
            if (!videoOn || !videoMicReady || callMicOn) return;
            // Start unmuting on pointer-down so Daily gets a head start before the click event and
            // the doctor's first syllable. This is only mic enablement, not a Tavus interrupt.
            suppressNextMicClickRef.current = true;
            setVideoDoctorMic(true);
          }}
          onClick={() => {
            if (videoOn) {
              if (suppressNextMicClickRef.current) {
                suppressNextMicClickRef.current = false;
                return;
              }
              if (!videoMicReady) {
                setNotice("The video rep is still connecting. The mic will be available once the call is live.");
                return;
              }
              setVideoDoctorMic(!callMicOn);
            }
            else toggleMic();
          }}
          disabled={doctorMicDisabled}
          aria-label={doctorMicOn ? "Turn microphone off" : "Turn microphone on"}
          title={doctorMicDisabled ? "The video rep is connecting — the mic will unlock when the call is live" : doctorMicArming ? "Your microphone is turning on…" : doctorMicOn ? "Your microphone is on — click to stop" : "Your microphone is off — click to talk"}
          style={{ padding: "11px 13px", background: doctorMicDisabled ? "#94a3b8" : doctorMicArming ? "#d97706" : doctorMicOff ? "var(--dn-danger)" : "var(--dn-brand-base)", color: "#fff", border: "1px solid var(--dn-border)", borderRadius: 9, fontSize: 15, cursor: doctorMicDisabled ? "not-allowed" : "pointer", opacity: doctorMicDisabled ? 0.75 : 1 }}
        >🎤</button>
      )}
      <button onClick={() => void ask(input)} disabled={pending} style={{ padding: "11px 18px", minWidth: 74, textAlign: "center", background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" }}>{pending ? "…" : label}</button>
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
                  ? <VideoAgentStage recordSession onMutedChange={setVideoMuted} onMicReadyChange={(ready) => { setVideoMicReady(ready); if (!ready) { setCallMicOn(false); setVideoMicActive(false); } }} onDoctorMicActiveChange={setVideoMicActive} onSessionReady={setActiveVideoSession} onHcpUtterance={addSpokenHcpTurn} normalizeHcpUtterance={correctSpokenHcpText} ref={videoAgentRef} onClose={() => { void endVideoSession(); setVideoOn(false); setActiveVideoSession(null); setVideoMicReady(false); setVideoMicActive(false); setCallMicOn(false); }} onRepTurn={syncVideoRepTurn} onRepAudioStart={onRepAudioStart} onHcpSpeechStart={cancelSlideCue} hcpId={inviteHcpId || undefined} />
                  : <LiveAvatar ref={liveRef} enabled={threeD} speaking={speaking} fallbackStream={null} fallbackStatus={listening ? "Listening…" : speaking ? "Speaking…" : "Ready"} height={300} />}
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "15px 16px", boxShadow: "var(--dn-shadow-card)" }}>{hintsCard}{askBar("Ask")}{tryChips}</div>
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "12px 14px", boxShadow: "var(--dn-shadow-card)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginRight: 2 }}>Guided overview</span>
                  <button onClick={() => void deckStep("start")} disabled={pending} style={ghostMd}>Start overview</button>
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
                    style={{ ...ghostMd, minWidth: 126, textAlign: "center", ...((videoOn ? !videoMuted : voiceOn) ? {} : { background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca" }) }}
                  >{(videoOn ? !videoMuted : voiceOn) ? "🔊 Rep voice on" : "🔇 Rep voice off"}</button>
                  <button onClick={async () => { if (videoOn) await endVideoSession(); setScr("complete"); }} style={{ marginLeft: "auto", padding: "10px 16px", background: "var(--dn-brand-dark)", color: "#fff", border: "none", borderRadius: 9, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer" }}>End session →</button>
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
            <button onClick={async () => { if (videoOn) await endVideoSession(); cancelSlideCue(); setScr("invite"); setMsgs([]); setNotice(""); setDeckFocus(""); setVideoOn(false); setActiveVideoSession(null); chatSessionRef.current = null; }} style={{ width: "100%", padding: 12, background: "var(--dn-surface-2)", color: "var(--dn-fg-muted)", border: "1px solid var(--dn-border)", borderRadius: 10, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer" }}>Close session</button>
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
