"use client";

import { useEffect, useRef, useState } from "react";
import type { AppState } from "./NexusRepApp";
import { createRecognizer, BrowserVoiceProvider, type ClientRecognizer } from "@lib/browser-speech";
import { streamArena } from "@lib/arena-client";
import { LiveAvatar, type LiveAvatarHandle } from "../_components/LiveAvatar";
import { TavusStage, type TavusStageHandle } from "../_components/TavusStage";
import { SlideView } from "../_components/SlideView";
import { useBrand } from "../_components/useBrand";
import { isOverviewPrompt } from "./overviewPrompt";

// Switch the on-screen slide a beat AFTER the answer starts — as the rep gets to "…you can
// see this on the X slide", not on the first word. Reads like a person pulling up the detail
// aid while talking, instead of the deck jump-cutting the instant a reply lands.
const SLIDE_CUE_DELAY_MS = 1100;

type HcpScreen = "invite" | "convo" | "complete";
interface Msg { role: "hcp" | "rep"; text: string; provider?: string; latencyMs?: number }
interface ModelInfo { name: string; label: string; available: boolean }
interface ABSide { provider: string; label: string; text: string; ttftMs?: number; totalMs?: number; running: boolean; error?: string }
interface ABRun { question: string; a: ABSide; b: ABSide }
interface OverviewSegment { response: string; detailAidSlideId?: string | null; sourceIds?: string[]; isiDelivered?: boolean }

export function HcpExperience({ app }: { app?: AppState }) {
  const brand = useBrand();
  const greeting = brand?.greeting ?? "";
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
  const [voiceOn, setVoiceOn] = useState(true);
  const [videoOn, setVideoOn] = useState(false);
  const [deckFocus, setDeckFocus] = useState<string>(""); // "" → SlideView shows the first slide (title)
  const [lab, setLab] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelA, setModelA] = useState("keyword");
  const [modelB, setModelB] = useState("mock");
  const [ab, setAb] = useState(false);
  const [abRun, setAbRun] = useState<ABRun | null>(null);
  const [fs, setFs] = useState(false);
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);

  const voiceRef = useRef<BrowserVoiceProvider | null>(null);
  const liveRef = useRef<LiveAvatarHandle | null>(null);
  const tavusRef = useRef<TavusStageHandle | null>(null);
  const recRef = useRef<ClientRecognizer | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // This text/voice chat's own reviewable session (video uses the Tavus session).
  const chatSessionRef = useRef<string | null>(null);
  // Pending mid-answer slide switch (cleared if a new question arrives first).
  const slideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    voiceRef.current = new BrowserVoiceProvider();
    void voiceRef.current.warmup();
    const rec = createRecognizer();
    recRef.current = rec;
    setMicSupported(rec.supported());
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { providers: ModelInfo[] }) => {
        setModels(d.providers);
        const avail = d.providers.filter((p) => p.available);
        if (avail[0]) setModelA(avail[0].name);
        setModelB(d.providers.find((p) => p.name !== (avail[0]?.name ?? "mock"))?.name ?? "mock");
      })
      .catch(() => {});
    return () => { voiceRef.current?.cancel(); document.removeEventListener("fullscreenchange", onFs); if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current); };
  }, []);

  const labelOf = (name: string) => models.find((m) => m.name === name)?.label ?? name;

  async function speak(text: string) {
    if (!voiceOn) return;
    setSpeaking(true);
    try {
      if (threeD && liveRef.current?.isReady()) await liveRef.current.speak(text);
      else await voiceRef.current?.speak(text, { voiceHint: "en" });
    } finally { setSpeaking(false); }
  }

  async function runAB(q: string) {
    const mk = (provider: string): ABSide => ({ provider, label: labelOf(provider), text: "", running: true });
    setAbRun({ question: q, a: mk(modelA), b: mk(modelB) });
    const onToken = (side: "a" | "b") => (t: string) =>
      setAbRun((prev) => (prev ? { ...prev, [side]: { ...prev[side], text: prev[side].text + t } } : prev));
    const runSide = async (side: "a" | "b", provider: string) => {
      const r = await streamArena({ provider, text: q, onToken: onToken(side) });
      setAbRun((prev) => (prev ? { ...prev, [side]: { ...prev[side], running: false, ttftMs: r.ttftMs, totalMs: r.totalMs, error: r.error } } : prev));
    };
    await Promise.all([runSide("a", modelA), runSide("b", modelB)]);
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
      "let's move to",
      "we'll start with",
      "i'll use",
      "i’d show",
      "i'd show",
    ];
    const idx = markers
      .map((m) => lower.indexOf(m))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (idx == null) return Math.min(4200, Math.max(SLIDE_CUE_DELAY_MS, body.split(/\s+/).filter(Boolean).length * 120));
    const wordsBefore = body.slice(0, idx).split(/\s+/).filter(Boolean).length;
    return Math.min(9000, Math.max(450, wordsBefore * 360 - 250));
  }

  function cueSlide(id?: string | null, spokenText?: string) {
    if (!id) return;
    if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current);
    slideTimerRef.current = window.setTimeout(() => setDeckFocus(id), slideCueDelay(spokenText));
  }

  function syncVideoRepTurn(turn: { text: string; detailAidSlideId?: string | null }) {
    const text = turn.text.trim();
    if (!text) return;
    setMsgs((current) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (current.some((m) => m.role === "rep" && norm(m.text) === norm(text))) return current;
      const hasHcp = current.some((m) => m.role === "hcp");
      // Before the doctor asks anything, the only local rep line is the preloaded greeting.
      // Replace it with the actual Tavus-spoken greeting so the video caption and transcript match.
      if (!hasHcp && current.every((m) => m.role === "rep")) return [{ role: "rep", text }];
      return [...current, { role: "rep", text }];
    });
    cueSlide(turn.detailAidSlideId, text);
  }

  async function playRepSegment(text: string) {
    if (videoOn) {
      tavusRef.current?.speak(text);
      await wait(estimateSpeechMs(text));
    } else {
      await speak(text);
    }
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text || pending) return;
    setInput("");
    if (lab && ab) { setPending(true); try { await runAB(text); } finally { setPending(false); } return; }
    setPending(true);
    setMsgs((m) => [...m, { role: "hcp", text }]);
    try {
      // Session routing: video → the live Tavus session (greeting comes via the replica
      // utterance). Text/voice → this chat's own session, created on the first message
      // with the greeting logged as turn 0 so it's in the transcript, not just the caption.
      const videoSession = videoOn ? (window as unknown as { __nexusrep?: { sessionId?: string } }).__nexusrep?.sessionId : undefined;
      const openNew = !videoOn && !chatSessionRef.current;
      const sessionId = videoSession ?? chatSessionRef.current ?? undefined;
      if (!lab && isOverviewPrompt(text)) {
        const res = await fetch("/api/presentation/overview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, sessionId, newSession: openNew, greeting: openNew && greeting ? greeting : undefined }),
        });
        const data = (await res.json()) as { sessionId?: string; segments?: OverviewSegment[] };
        if (!videoOn && data.sessionId) chatSessionRef.current = data.sessionId;
        for (const segment of data.segments ?? []) {
          setMsgs((m) => [...m, { role: "rep", text: segment.response }]);
          cueSlide(segment.detailAidSlideId, segment.response);
          await playRepSegment(segment.response);
        }
        return;
      }
      const res = await fetch("/api/conversation/turn", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, classifier: lab ? modelA : undefined, sessionId, newSession: openNew, greeting: openNew && greeting ? greeting : undefined }),
      });
      const data = (await res.json()) as { response: string; isiDelivered: boolean; followUp: string | null; detailAid: { title: string; label: string } | null; detailAidSlideId?: string | null; provider: string; latencyMs: number; sessionId?: string };
      if (!videoOn && data.sessionId) chatSessionRef.current = data.sessionId;
      setMsgs((m) => [...m, { role: "rep", text: data.response, provider: lab ? labelOf(modelA) : undefined, latencyMs: lab ? data.latencyMs : undefined }]);
      // The rep "shows" the detail-aid slide the answer surfaced (source-driven, not guessed),
      // but a beat LATER — as it says "…you can see this on the X slide" — so the deck follows
      // the rep mid-answer instead of jump-cutting on word one. Routed answers (no slide) keep
      // the current slide up, like a person.
      cueSlide(data.detailAidSlideId, data.response);
      if (data.followUp) setNotice(followUpNotice(data.followUp));
      // Voice: the live replica speaks it (echo) when on video; otherwise browser/3D TTS.
      if (videoOn) await playRepSegment(data.response);
      else void speak(data.response);
    } finally { setPending(false); }
  }

  async function deckStep(action: "start" | "next" | "previous" | "jump", query?: string, displayText?: string) {
    if (pending) return;
    const label = displayText?.trim() || (action === "next" ? "Please keep going." : action === "previous" ? "Can you go back to the prior point?" : action === "jump" && query ? `Can you talk about ${query}?` : "Can you walk me through the approved information?");
    setPending(true);
    setMsgs((m) => [...m, { role: "hcp", text: label }]);
    try {
      const videoSession = videoOn ? (window as unknown as { __nexusrep?: { sessionId?: string } }).__nexusrep?.sessionId : undefined;
      const openNew = !videoOn && !chatSessionRef.current;
      const sessionId = videoSession ?? chatSessionRef.current ?? undefined;
      const res = await fetch("/api/presentation/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, query, displayText: label, currentSlideId: deckFocus || undefined, sessionId, newSession: openNew, greeting: openNew && greeting ? greeting : undefined }),
      });
      const data = (await res.json()) as { response: string; detailAidSlideId?: string | null; sessionId?: string; step?: { index: number; total: number } | null };
      if (!videoOn && data.sessionId) chatSessionRef.current = data.sessionId;
      setMsgs((m) => [...m, { role: "rep", text: data.response }]);
      cueSlide(data.detailAidSlideId, data.response);
      if (videoOn) await playRepSegment(data.response);
      else void speak(data.response);
    } finally {
      setPending(false);
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

  const askBar = (label: string) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(input); }} placeholder={listening ? "Listening…" : videoOn ? "Type, or talk to the rep…" : "Type or tap the mic to talk…"} style={{ flex: 1, padding: "11px 13px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 13px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
      {micSupported && !videoOn && (
        <button type="button" onClick={toggleMic} aria-label="Talk" title="Ask by voice" style={{ padding: "11px 13px", background: listening ? "var(--dn-danger)" : "#fff", color: listening ? "#fff" : "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 9, fontSize: 15, cursor: "pointer" }}>🎤</button>
      )}
      <button onClick={() => void ask(input)} disabled={pending} style={{ padding: "11px 18px", background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" }}>{pending ? "…" : label}</button>
    </div>
  );
  const tryChips = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
      <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", alignSelf: "center" }}>Try:</span>
      {tryQuestions.map((q) => <span key={q} onClick={() => void ask(q)} style={{ padding: "7px 11px", background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderRadius: 20, font: "500 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", cursor: "pointer" }}>{q.replace("What's the ", "").replace("Tell me about the ", "").replace(/\?$/, "")}</span>)}
    </div>
  );
  const modelStrip = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, fontSize: 12 }}>
      <button onClick={() => setLab((v) => !v)} style={{ ...ghostSm, padding: "6px 11px", fontSize: 11.5, background: lab ? "var(--dn-brand-base)" : "var(--dn-surface)", color: lab ? "#fff" : "var(--dn-fg-muted)" }}>⚙ Test models {lab ? "on" : "off"}</button>
      {lab && (
        <>
          <label style={{ color: "var(--dn-fg-muted)" }}>Model{ab ? " A" : ""}:{" "}
            <select value={modelA} onChange={(e) => setModelA(e.target.value)} style={sel}>{models.map((m) => <option key={m.name} value={m.name} disabled={!m.available}>{m.label}{m.available ? "" : " — add key"}</option>)}</select>
          </label>
          <label style={{ color: "var(--dn-fg-muted)", display: "inline-flex", alignItems: "center", gap: 5 }}><input type="checkbox" checked={ab} onChange={(e) => setAb(e.target.checked)} /> A/B compare</label>
          {ab && (
            <label style={{ color: "var(--dn-fg-muted)" }}>Model B:{" "}
              <select value={modelB} onChange={(e) => setModelB(e.target.value)} style={sel}>{models.map((m) => <option key={m.name} value={m.name} disabled={!m.available}>{m.label}{m.available ? "" : " — add key"}</option>)}</select>
            </label>
          )}
        </>
      )}
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
              <h1 style={{ font: "600 23px/1.25 var(--dn-font-sans)", margin: 0, letterSpacing: "-0.01em" }}>You're invited to an AI-guided session on {displayName}</h1>
              <p style={{ font: "400 13px/1.55 var(--dn-font-sans)", color: "rgba(255,255,255,.85)", margin: "12px 0 0" }}>A brief, on-demand walkthrough of publicly-disclosed information on {displayName}{tagline ? ` — ${tagline}` : ""} — answer questions at your own pace.</p>
            </div>
            <div style={{ padding: "26px 32px" }}>
              <div style={{ padding: "14px 16px", background: "var(--dn-surface-2)", borderRadius: 11, marginBottom: 22 }}>
                <div style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 8 }}>What to expect</div>
                <div style={{ font: "400 12px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>You'll talk with an AI representative that shares only publicly-disclosed information about {displayName}.{brand?.investigational ? ` ${displayName} is investigational and not FDA approved —` : ""} the rep routes clinical questions like dosing, efficacy, or safety to Medical Information, and you can ask for a human rep or MSL anytime.</div>
              </div>
              <button onClick={() => { setMsgs(greeting ? [{ role: "rep", text: greeting }] : []); setScr("convo"); }} style={{ width: "100%", padding: 14, background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 10, font: "600 14px/1 var(--dn-font-sans)", cursor: "pointer" }}>Start session</button>
            </div>
          </div>
        </div>
      )}

      {scr === "convo" && (
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
          {notice && <Notice text={notice} onClose={() => setNotice("")} />}
          {/* Model-testing is an INTERNAL brand tool — shown only in the in-app brand preview
              (app present), never to a real HCP on the shared /hcp link (doctor-view jargon rule). */}
          {app && modelStrip}

          {lab && ab ? (
            /* ── A/B benchmark — symmetric two columns, no captions ── */
            <div>
              <div style={{ maxWidth: 620, margin: "0 auto 16px" }}>{askBar("A/B")}{tryChips}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {([abRun?.a, abRun?.b] as (ABSide | undefined)[]).map((s, i) => (
                  <div key={i} style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", minHeight: 200, display: "flex", flexDirection: "column" }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--dn-border)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--dn-brand-base)" }}>{s?.label ?? (i === 0 ? labelOf(modelA) : labelOf(modelB))}</span>
                      <span style={{ fontSize: 11, color: "var(--dn-fg-muted)" }}>{s ? (s.running ? "streaming…" : s.error ? "error" : `${s.ttftMs}ms → ${s.totalMs}ms`) : "idle"}</span>
                    </div>
                    <div style={{ padding: "14px 16px", fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap", color: s?.error ? "var(--dn-danger)" : "var(--dn-fg)" }}>{s?.error ? s.error : s?.text || (s?.running ? "…" : "Ask a question to compare.")}</div>
                  </div>
                ))}
              </div>
              <div style={{ textAlign: "center", marginTop: 12, fontSize: 11, color: "var(--dn-fg-subtle)" }}>Internal benchmark — free-generated, not the compliant rep answer.</div>
            </div>
          ) : (
            /* ── Compliant rep conversation ── */
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, alignItems: "start" }}>
              {/* LEFT — the rep (live Tavus video OR the 3D/2D avatar) + one ask bar */}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {videoOn
                  ? <TavusStage ref={tavusRef} onClose={() => setVideoOn(false)} onRepTurn={syncVideoRepTurn} />
                  : <LiveAvatar ref={liveRef} enabled={threeD} speaking={speaking} fallbackStream={null} fallbackStatus={listening ? "Listening…" : speaking ? "Speaking…" : "Ready"} height={300} />}
                <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "15px 16px", boxShadow: "var(--dn-shadow-card)" }}>{askBar("Ask")}{tryChips}</div>
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
                  <button onClick={() => setVideoOn((v) => !v)} title="Live video representative (Tavus)" style={{ ...ghostMd, color: videoOn ? "#fff" : "var(--dn-fg)", background: videoOn ? "var(--dn-brand-base)" : "#fff" }}>{videoOn ? "🎥 Video on" : "🎥 Video rep"}</button>
                  {!videoOn && <button onClick={() => setThreeD((v) => !v)} style={{ ...ghostMd, color: threeD ? "#fff" : "var(--dn-fg)", background: threeD ? "var(--dn-brand-base)" : "#fff" }}>{threeD ? "🧑 3D: on" : "🧑 3D avatar"}</button>}
                  {!videoOn && <button onClick={() => { if (voiceOn) voiceRef.current?.cancel(); setVoiceOn((v) => !v); }} style={ghostMd}>{voiceOn ? "🔊 Sound on" : "🔇 Sound off"}</button>}
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
                        <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 4, textAlign: m.role === "hcp" ? "right" : "left" }}>{m.role === "hcp" ? "You" : "AI rep"}{m.provider ? ` · ${m.provider} · ${m.latencyMs}ms` : ""}</div>
                        <div style={{ padding: "9px 12px", borderRadius: 11, font: "400 12.5px/1.5 var(--dn-font-sans)", whiteSpace: "pre-wrap", background: m.role === "hcp" ? "var(--dn-brand-base)" : "var(--dn-surface-2)", color: m.role === "hcp" ? "#fff" : "var(--dn-fg)", border: m.role === "hcp" ? "none" : "1px solid var(--dn-border)" }}>{m.text}</div>
                      </div>
                    ))}
                    {pending && <div style={{ font: "400 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Checking approved information…</div>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {scr === "complete" && (
        <div style={{ minHeight: "calc(100vh - 56px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
          <div style={{ maxWidth: 540, width: "100%", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 18, boxShadow: "var(--dn-shadow-medical)", overflow: "hidden", textAlign: "center", padding: "30px 32px 26px" }}>
            <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--dn-accent-green-bg)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 26, color: "#166534" }}>✓</div>
            <h1 style={{ font: "600 21px/1.25 var(--dn-font-sans)", margin: 0, color: "var(--dn-fg)" }}>Thanks for your time</h1>
            <p style={{ font: "400 13px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "10px 0 20px" }}>Request a follow-up and we'll send approved {displayName} information or connect you with our team.</p>
            <button onClick={() => { if (slideTimerRef.current) window.clearTimeout(slideTimerRef.current); setScr("invite"); setMsgs([]); setNotice(""); setDeckFocus(""); setVideoOn(false); setAbRun(null); chatSessionRef.current = null; }} style={{ width: "100%", padding: 12, background: "var(--dn-surface-2)", color: "var(--dn-fg-muted)", border: "1px solid var(--dn-border)", borderRadius: 10, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer" }}>Close session</button>
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
const sel: React.CSSProperties = { padding: "5px 8px", border: "1px solid var(--dn-border)", borderRadius: 7, fontSize: 12, background: "#fff", color: "var(--dn-fg)" };
