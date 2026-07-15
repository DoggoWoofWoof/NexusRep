/**
 * Real browser-native A/V (no API keys, no vendor accounts). This is the
 * client-side realtime layer: actual spoken audio via the Web Speech
 * SpeechSynthesis API and real microphone transcription via SpeechRecognition.
 *
 * It implements `ClientVoiceProvider` — the same interface a future ElevenLabs
 * or GPT-Realtime client adapter would implement, so swapping to a paid provider
 * (once a key exists) is a drop-in, not a rewrite. There is no mock here; if the
 * platform genuinely lacks speech support (e.g. headless CI with no installed
 * voices), `speak()` falls back to real-time pacing so the UI still flows.
 */

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  /** Substring hint to prefer a particular installed voice (e.g. "en"). */
  voiceHint?: string;
  /** Rep tone (professional / warm / clinical) — drives OpenAI TTS style instructions. */
  tone?: string;
  /** OpenAI TTS voice id override (else the server default / OPENAI_TTS_VOICE). */
  voice?: string;
}

/** Map a persona voice tone to TTS delivery params, so picking a tone audibly changes how the
 *  built-in voice sounds — not just the words. Deltas are gentle so speech stays natural. */
export function toneSpeechOpts(style?: string): SpeakOptions {
  switch (style) {
    case "warm":
      return { rate: 0.97, pitch: 1.06 };
    case "clinical":
      return { rate: 0.92, pitch: 0.95 };
    case "professional":
      return { rate: 1.03, pitch: 1.0 };
    default:
      return {};
  }
}


export interface ClientVoiceProvider {
  readonly name: string;
  /** Warm up any resources (voices/models) so the first speak() isn't cold. */
  warmup(): Promise<void>;
  /** Speak text aloud. Resolves when speech finishes (or the pacing fallback elapses). */
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  cancel(): void;
  /** True when real synthesized audio is available on this device. */
  audioAvailable(): boolean;
}

/** Estimate speaking time (~150 wpm) — used for pacing fallback and as a safety cap. */
/** Session-wide speech locale. The brand persona declares a language word ("english");
 *  the HCP view maps it here once loaded — recognizers read it at START time, so the
 *  async brand fetch can never leave a stale locale baked into a constructor. */
let speechLocale = "en-US";
const SPEECH_LOCALES: Record<string, string> = {
  english: "en-US", spanish: "es-ES", french: "fr-FR", german: "de-DE", italian: "it-IT",
  portuguese: "pt-BR", japanese: "ja-JP", chinese: "zh-CN", hindi: "hi-IN",
};
export function setSpeechLanguage(language?: string): void {
  const l = (language ?? "").trim().toLowerCase();
  speechLocale = SPEECH_LOCALES[l] ?? (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(l) ? l : "en-US");
}
export function speechVoiceHint(): string {
  return speechLocale.slice(0, 2);
}

export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(700, Math.round((words / 2.5) * 1000));
}

const hasSynthesis = (): boolean =>
  typeof window !== "undefined" && "speechSynthesis" in window;

/** Wait for installed voices to load (they populate asynchronously on some browsers). */
export async function ensureVoices(timeoutMs = 800): Promise<SpeechSynthesisVoice[]> {
  if (!hasSynthesis()) return [];
  const existing = window.speechSynthesis.getVoices();
  if (existing.length) return existing;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, timeoutMs);
  });
}

function pickVoice(voices: SpeechSynthesisVoice[], hint?: string): SpeechSynthesisVoice | undefined {
  if (!voices.length) return undefined;
  if (hint) {
    const m = voices.find((v) => v.lang.toLowerCase().includes(hint) || v.name.toLowerCase().includes(hint));
    if (m) return m;
  }
  return voices.find((v) => v.lang.toLowerCase().startsWith("en")) ?? voices[0];
}

/** Split text into short speakable chunks. Chrome silently kills any utterance around
 *  the ~15s mark and WEDGES the synthesis queue (speaking stays true, every later
 *  speak() is silent until reload) — short sentence chunks never get there. */
function chunkForSpeech(text: string, max = 220): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > max) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
    // A single overlong sentence still gets split on commas/spaces.
    while (current.length > max) {
      const cut = current.lastIndexOf(",", max) > 40 ? current.lastIndexOf(",", max) + 1 : max;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(cut);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

export class BrowserVoiceProvider implements ClientVoiceProvider {
  readonly name = "browser-webspeech";
  private voices: SpeechSynthesisVoice[] = [];
  /** Bumped by cancel(); an in-flight chunked speak() stops when it no longer matches. */
  private speakSession = 0;

  async warmup(): Promise<void> {
    this.voices = await ensureVoices();
  }

  audioAvailable(): boolean {
    return hasSynthesis() && this.voices.length > 0;
  }

  speak(text: string, opts?: SpeakOptions): Promise<void> {
    // No real audio available → pace in real time so the UI still flows (CI/headless).
    if (!this.audioAvailable()) {
      return new Promise((r) => setTimeout(r, Math.min(estimateSpeechMs(text), 1200)));
    }
    const session = ++this.speakSession;
    return new Promise<void>((resolve) => {
      const synth = window.speechSynthesis;
      const chunks = chunkForSpeech(text);
      const v = pickVoice(this.voices, opts?.voiceHint);
      let idx = 0;
      let settled = false;
      // Second Chrome workaround: a periodic pause/resume nudge keeps the engine from
      // stalling between chunks on some platforms (notably Windows).
      const keepalive = window.setInterval(() => {
        try { if (synth.speaking) { synth.pause(); synth.resume(); } } catch { /* noop */ }
      }, 10_000);
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearInterval(keepalive);
        resolve();
      };
      const speakNext = () => {
        if (settled) return;
        if (this.speakSession !== session || idx >= chunks.length) { finish(); return; }
        const u = new SpeechSynthesisUtterance(chunks[idx++]!);
        u.rate = opts?.rate ?? 1;
        u.pitch = opts?.pitch ?? 1;
        if (v) u.voice = v;
        u.onend = speakNext;
        u.onerror = speakNext; // a broken chunk must not silence the rest
        synth.speak(u);
      };
      // Safety net: never hang if onend doesn't fire on some platform.
      setTimeout(finish, estimateSpeechMs(text) + 8000);
      synth.cancel();
      // Chrome drops an utterance queued in the same tick as cancel() — give it a beat.
      setTimeout(speakNext, 60);
    });
  }

  cancel(): void {
    this.speakSession++;
    if (hasSynthesis()) window.speechSynthesis.cancel();
  }
}

/**
 * Rep voice via OpenAI TTS (a real, natural voice with the selected tone) when the video replica
 * is OFF. It POSTs the answer text to /api/voice/speak and plays the returned mp3; if there's no
 * TTS key (204) or any error, it transparently falls back to the browser Web Speech voice. Same
 * ClientVoiceProvider shape (speak/cancel), so call sites don't change — and cancel() aborts the
 * in-flight request + stops playback for barge-in.
 */
export class OpenAiVoiceProvider implements ClientVoiceProvider {
  readonly name = "openai-tts";
  private readonly fallback = new BrowserVoiceProvider();
  private current: HTMLAudioElement | null = null;
  private ctrl: AbortController | null = null;
  private gen = 0;
  constructor(private readonly voice?: string) {}

  async warmup(): Promise<void> {
    await this.fallback.warmup();
  }

  audioAvailable(): boolean {
    return true; // tries TTS, then falls back to the browser voice
  }

  private stopAudio(): void {
    if (this.current) {
      try { this.current.pause(); } catch { /* noop */ }
      this.current = null;
    }
  }

  async speak(text: string, opts?: SpeakOptions): Promise<void> {
    const body = (text ?? "").trim();
    if (!body) return;
    this.stopAudio();
    const gen = ++this.gen;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    let timedOut = false;
    // OpenAI TTS generates the whole clip server-side (~1-3s for a real answer, more on a cold
    // start), and the server route itself waits up to 20s. A tight 1.2s ceiling here aborted almost
    // every non-cached line and dumped us onto the robotic BROWSER voice — the exact "why is it
    // using browser audio" bug. Give TTS room to finish; barge-in still cancels instantly via
    // cancel() (this timer is only the "give up and use the browser voice" backstop).
    const timeout = window.setTimeout(() => {
      timedOut = true;
      try { ctrl.abort(); } catch { /* noop */ }
    }, 15000);
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, tone: opts?.tone, voice: opts?.voice ?? this.voice }),
        signal: ctrl.signal,
      });
      if (this.gen !== gen) return; // superseded by a newer speak/cancel (barge-in)
      if (!res.ok || res.status === 204) {
        window.clearTimeout(timeout);
        return void (await this.fallback.speak(body, opts));
      }
      const blob = await res.blob();
      window.clearTimeout(timeout);
      if (this.gen !== gen) return;
      if (!blob.size) return void (await this.fallback.speak(body, opts));
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      this.current = a;
      await new Promise<void>((resolve) => {
        const done = () => { try { URL.revokeObjectURL(url); } catch { /* noop */ } resolve(); };
        a.onended = done;
        a.onerror = done;
        a.play().catch(done);
      });
    } catch (e) {
      window.clearTimeout(timeout);
      // Timeout AbortError = cold TTS start → browser fallback; user barge-in AbortError is dropped.
      if (this.gen === gen && (timedOut || (e as { name?: string })?.name !== "AbortError")) {
        await this.fallback.speak(body, opts);
      }
    }
  }

  cancel(): void {
    this.gen++; // supersede any in-flight speak
    if (this.ctrl) { try { this.ctrl.abort(); } catch { /* noop */ } this.ctrl = null; }
    this.stopAudio();
    this.fallback.cancel();
  }
}

// ── Microphone (real speech-to-text) ─────────────────────────────────────────

export interface ClientRecognizer {
  supported(): boolean;
  /** Start listening; calls onResult with the final transcript (and, when the engine provides them,
   *  the ranked alternatives so a caller can pick the one that best recovers known terms), then
   *  onEnd. onInterim (if given) streams live partial text so the UI can show what's being heard. */
  start(onResult: (text: string, alternatives?: string[]) => void, onEnd?: () => void, onInterim?: (text: string) => void): void;
  stop(): void;
  /** True when transcription runs on-device (no audio leaves the browser). */
  readonly onDevice?: boolean;
}

interface SpeechResultLike { readonly isFinal: boolean; readonly length: number; [i: number]: { transcript: string } }
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<SpeechResultLike> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e?: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class BrowserRecognizer implements ClientRecognizer {
  private rec: SpeechRecognitionLike | null = null;

  supported(): boolean {
    return getRecognitionCtor() !== null;
  }

  start(onResult: (text: string, alternatives?: string[]) => void, onEnd?: () => void, onInterim?: (text: string) => void): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      onEnd?.();
      return;
    }
    const rec = new Ctor();
    rec.lang = speechLocale;
    // interimResults → live "what I'm hearing" feedback so the doctor sees it working immediately;
    // continuous=false → the engine finalizes on the natural end-of-question pause (fast auto-submit)
    // instead of waiting for a second click. One tap: speak, and it answers.
    rec.interimResults = true;
    rec.continuous = false;
    // Ask for several alternatives: the engine often mis-hears a drug name as its top guess but has
    // the right proper noun lower down — the caller re-ranks them against known terms.
    rec.maxAlternatives = 4;
    let finalText = "";
    let finalAlts: string[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.rec = null;
      const t = finalText.trim();
      if (t) onResult(t, finalAlts.length > 1 ? finalAlts : undefined); // deliver once, on the finalized phrase
      onEnd?.();
    };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript ?? "";
        if (r?.isFinal) {
          finalText += t;
          // Capture this final chunk's ranked alternatives (best-first) for hotword re-ranking.
          const alts: string[] = [];
          for (let j = 0; j < r.length; j++) { const a = r[j]?.transcript?.trim(); if (a) alts.push(a); }
          if (alts.length) finalAlts = alts;
        } else interim += t;
      }
      if (interim.trim()) onInterim?.(interim.trim());
    };
    rec.onend = finish;
    rec.onerror = finish; // no-speech / aborted / network → end cleanly, no throw
    this.rec = rec;
    try { rec.start(); } catch { finish(); }
  }

  stop(): void {
    const r = this.rec;
    this.rec = null;
    try { r?.stop(); } catch { /* already stopped */ }
  }
}

// ── Whisper (on-device STT via Transformers.js — no audio leaves the device) ──
//
// Push-to-talk: start() records the mic; stop() finalizes and transcribes the
// captured audio entirely in-browser with Xenova/whisper-tiny.en. No audio is
// ever uploaded — this removes the cloud-STT privacy caveat. Any failure
// (permissions, WebGPU/model load, decode) degrades gracefully by calling
// onEnd() and never throws to the caller.

type WhisperPipe = (
  audio: Float32Array,
  opts?: object,
) => Promise<{ text?: string } | { text?: string }[]>;

let whisperPromise: Promise<WhisperPipe> | null = null;
function getWhisperPipe(): Promise<WhisperPipe> {
  if (!whisperPromise) {
    whisperPromise = (async () => {
      const tf = (await import("@xenova/transformers")) as unknown as {
        env: { allowLocalModels: boolean };
        pipeline: (task: string, model: string) => Promise<WhisperPipe>;
      };
      tf.env.allowLocalModels = false;
      return tf.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
    })();
  }
  return whisperPromise;
}

/** Downmix (any channel count) to mono and resample to 16 kHz, as Whisper expects. */
async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const AudioCtx =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) throw new Error("AudioContext unavailable");

  const arrayBuf = await blob.arrayBuffer();
  const decodeCtx = new AudioCtx();
  let audioBuf: AudioBuffer;
  try {
    audioBuf = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }

  // Downmix to mono.
  const chs = audioBuf.numberOfChannels;
  const mono = new Float32Array(audioBuf.length);
  for (let c = 0; c < chs; c++) {
    const data = audioBuf.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] = (mono[i] ?? 0) + data[i]! / chs;
  }

  const targetRate = 16000;
  if (audioBuf.sampleRate === targetRate) return mono;

  // Resample to 16 kHz via OfflineAudioContext.
  const frames = Math.max(1, Math.round((mono.length * targetRate) / audioBuf.sampleRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const monoBuf = offline.createBuffer(1, mono.length, audioBuf.sampleRate);
  monoBuf.copyToChannel(mono, 0);
  const src = offline.createBufferSource();
  src.buffer = monoBuf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function whisperSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const hasMedia = Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
  const hasRecorder = typeof (window as { MediaRecorder?: unknown }).MediaRecorder !== "undefined";
  const hasAudioCtx =
    typeof (window as { AudioContext?: unknown }).AudioContext !== "undefined" ||
    typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined";
  return hasMedia && hasRecorder && hasAudioCtx;
}

export class WhisperRecognizer implements ClientRecognizer {
  readonly onDevice = true;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private onEnd?: () => void;

  supported(): boolean {
    return whisperSupported();
  }

  start(onResult: (text: string) => void, onEnd?: () => void): void {
    this.onEnd = onEnd;
    // Any synchronous or async failure funnels to a single safe onEnd().
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.stream = stream;
        const recorder = new MediaRecorder(stream);
        this.recorder = recorder;
        this.chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        recorder.onerror = () => this.transcribe(onResult);
        recorder.onstop = () => void this.transcribe(onResult);
        recorder.start();
      } catch {
        this.cleanup();
        this.finish();
      }
    })();
  }

  stop(): void {
    // Trigger onstop → transcription. If nothing is recording, just end safely.
    const r = this.recorder;
    if (r && r.state !== "inactive") {
      try {
        r.stop();
      } catch {
        this.cleanup();
        this.finish();
      }
    } else if (!r) {
      // start() never got far enough (e.g. permission denied already ended it).
    }
  }

  private async transcribe(onResult: (text: string) => void): Promise<void> {
    const chunks = this.chunks;
    this.chunks = [];
    this.releaseStream();
    this.recorder = null;
    try {
      if (chunks.length) {
        const blob = new Blob(chunks, { type: chunks[0]!.type || "audio/webm" });
        const audio = await decodeToMono16k(blob);
        if (audio.length) {
          const pipe = await getWhisperPipe();
          const out = await pipe(audio);
          const text = (Array.isArray(out) ? out[0]?.text : out.text) ?? "";
          const trimmed = text.trim();
          if (trimmed) onResult(trimmed);
        }
      }
    } catch {
      // Model load / decode / permission failure → silent, safe fallback.
    } finally {
      this.finish();
    }
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private cleanup(): void {
    this.releaseStream();
    this.recorder = null;
    this.chunks = [];
  }

  private finish(): void {
    const cb = this.onEnd;
    this.onEnd = undefined;
    cb?.();
  }
}

// ── Factory + no-op stub ──────────────────────────────────────────────────────

/** A recognizer that reports itself unsupported and never does anything. */
class NullRecognizer implements ClientRecognizer {
  supported(): boolean {
    return false;
  }
  start(_onResult: (text: string) => void, onEnd?: () => void): void {
    onEnd?.();
  }
  stop(): void {}
}

/**
 * Pick a recognizer. Default is "browser" (Web Speech): one tap, live interim text, and it
 * auto-submits on the end-of-question pause — fast and reliable on Chrome/Edge, which is what
 * the doctor voice mode needs. Its audio goes to the browser's STT (a cloud vendor on Chrome) —
 * the same posture as the video rep, which already streams the doctor's mic to Tavus. Pass
 * "whisper" for fully on-device transcription (no audio leaves the browser) at the cost of a
 * model download + slower push-to-talk. Either falls back to the other, then to a no-op stub.
 */
export function createRecognizer(prefer: "browser" | "whisper" = "browser"): ClientRecognizer {
  const browser = () => { const b = new BrowserRecognizer(); return b.supported() ? b : null; };
  const whisper = () => { const w = new WhisperRecognizer(); return w.supported() ? w : null; };
  const order = prefer === "whisper" ? [whisper, browser] : [browser, whisper];
  for (const make of order) { const r = make(); if (r) return r; }
  return new NullRecognizer();
}
