"use client";

/**
 * Voice-activity barge-in for the video-OFF path. Tavus does this natively on video; off-video the
 * rep speaks via browser TTS, so we listen on an ECHO-CANCELLED mic stream and, when the doctor
 * actually talks over the rep for a sustained moment, fire a callback (the caller stops the rep and
 * starts capturing the question). Energy-based (not the recognizer) so it can't transcribe — and
 * with echoCancellation/noiseSuppression the rep's own TTS is largely removed, so the rep doesn't
 * interrupt itself. Best-effort: mic denied / unsupported → returns null and the app keeps its
 * tap-to-talk barge-in. Conservative thresholds avoid false triggers; tune via opts if needed.
 */

export interface BargeController {
  stop(): void;
}

interface BargeOpts {
  /** RMS level (0..1) the mic must exceed to count as speech. Echo cancellation keeps the rep's
   *  own audio well below this; real speech is comfortably above. */
  threshold?: number;
  /** How long (ms) sustained energy must persist before it's treated as a real barge-in (not a
   *  cough/click/blip). */
  sustainMs?: number;
}

export async function startBargeInVad(onSpeech: () => void, opts: BargeOpts = {}): Promise<BargeController | null> {
  if (typeof window === "undefined" || !navigator?.mediaDevices?.getUserMedia) return null;
  const threshold = opts.threshold ?? 0.055;
  const sustainMs = opts.sustainMs ?? 320;

  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let raf = 0;
  const cleanup = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    stream = null;
    ctx = null;
  };

  try {
    // Don't pop a mic prompt mid-greeting: only listen for barge-in once the mic is ALREADY granted
    // (the doctor has tapped the mic at least once). If the Permissions API is absent, we skip too —
    // barge-in is a nicety, and tap-to-talk always works.
    const perm = await navigator.permissions?.query({ name: "microphone" as PermissionName }).catch(() => null);
    if (!perm || perm.state !== "granted") { cleanup(); return null; }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (stopped) { cleanup(); return null; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) { cleanup(); return null; }
    ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let above = 0;
    let last = performance.now();
    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const s of buf) { const c = (s - 128) / 128; sum += c * c; }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (rms >= threshold) {
        above += dt;
        if (above >= sustainMs) { const cb = onSpeech; cleanup(); cb(); return; }
      } else {
        above = Math.max(0, above - dt * 1.5); // decay faster than it accrues → needs real, sustained speech
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  } catch {
    cleanup();
    return null;
  }
  return { stop: cleanup };
}
