"use client";

/**
 * Optional "Live 3D avatar" — a TalkingHead (3D) avatar driven by HeadTTS, a free
 * in-browser neural voice (WebGPU). Both load from CDN at runtime via the import
 * map in layout.tsx; nothing is fetched unless `enabled` is true. If WebGPU,
 * network, or the model load fails (e.g. headless CI, Safari), it falls back to
 * the coded RepAvatar so the page always works.
 *
 * A premium/cloned voice (ElevenLabs) or a hosted avatar (MascotBot/Tavus) would
 * replace these behind the same `speak()` surface once a key exists.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { estimateSpeechMs } from "@lib/browser-speech";
import { RepAvatar } from "./RepAvatar";

export interface LiveAvatarHandle {
  isReady(): boolean;
  speak(text: string): Promise<void>;
}

type LoadState = "off" | "loading" | "ready" | "error";

const DEFAULT_AVATAR =
  process.env.NEXT_PUBLIC_NEXUSREP_AVATAR_URL ??
  "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb";
const DEFAULT_VOICE = "af_bella";

export const LiveAvatar = forwardRef<
  LiveAvatarHandle,
  {
    enabled: boolean;
    speaking: boolean;
    fallbackStream: MediaStream | null;
    fallbackStatus: string;
    height?: number;
    avatarUrl?: string;
    voice?: string;
  }
>(function LiveAvatar(
  { enabled, speaking, fallbackStream, fallbackStatus, height = 240, avatarUrl, voice },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<import("talkinghead").TalkingHead | null>(null);
  const ttsRef = useRef<import("headtts").HeadTTS | null>(null);
  const [state, setState] = useState<LoadState>("off");

  useEffect(() => {
    if (!enabled) {
      setState("off");
      return;
    }
    let cancelled = false;
    setState("loading");

    (async () => {
      try {
        const [{ TalkingHead }, { HeadTTS }] = await Promise.all([
          import(/* webpackIgnore: true */ "talkinghead"),
          import(/* webpackIgnore: true */ "headtts"),
        ]);
        if (cancelled || !containerRef.current) return;

        const head = new TalkingHead(containerRef.current, {
          lipsyncModules: ["en"],
          lipsyncLang: "en",
          cameraView: "upper",
        });
        await head.showAvatar({ url: avatarUrl ?? DEFAULT_AVATAR, body: "F", lipsyncLang: "en" });
        if (cancelled) return;

        const tts = new HeadTTS({
          endpoints: ["webgpu"],
          languages: ["en-us"],
          voices: [voice ?? DEFAULT_VOICE],
          workerModule: "https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.3/modules/worker-tts.mjs",
          dictionaryURL: "https://cdn.jsdelivr.net/npm/@met4citizen/headtts@1.3/dictionaries/",
        });
        await tts.connect();
        tts.setup({ voice: voice ?? DEFAULT_VOICE, language: "en-us", audioEncoding: "wav" });
        if (cancelled) return;

        headRef.current = head;
        ttsRef.current = tts;
        setState("ready");
      } catch (e) {
        console.warn("[LiveAvatar] 3D avatar unavailable, falling back:", e);
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      try {
        headRef.current?.stop?.();
      } catch {
        /* noop */
      }
      headRef.current = null;
      ttsRef.current = null;
    };
  }, [enabled, avatarUrl, voice]);

  useImperativeHandle(
    ref,
    () => ({
      isReady: () => state === "ready" && !!headRef.current && !!ttsRef.current,
      speak: (text: string) =>
        new Promise<void>((resolve) => {
          const head = headRef.current;
          const tts = ttsRef.current;
          if (!head || !tts) {
            resolve();
            return;
          }
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          tts.onmessage = (message) => {
            if (message.type !== "audio") return;
            try {
              head.speakAudio(message.data, {}, null);
              const wtimes = (message.data.wtimes as number[]) ?? [];
              const wdur = (message.data.wdurations as number[]) ?? [];
              const end = wtimes.length
                ? Math.max(...wtimes.map((t, i) => t + (wdur[i] ?? 0)))
                : estimateSpeechMs(text);
              setTimeout(finish, end + 700);
            } catch {
              finish();
            }
          };
          tts.synthesize({ input: text });
          setTimeout(finish, Math.max(estimateSpeechMs(text) + 6000, 9000)); // hard safety cap
        }),
    }),
    [state],
  );

  const showFallback = !enabled || state === "error";

  return (
    <div style={{ position: "relative", height }} data-testid="live-avatar" data-live-state={state}>
      {enabled && (
        <div
          ref={containerRef}
          aria-label="AI representative video"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "var(--dn-radius-lg)",
            overflow: "hidden",
            background: "var(--dn-gradient-primary)",
            display: showFallback ? "none" : "block",
          }}
        />
      )}
      {showFallback && (
        <RepAvatar speaking={speaking} stream={fallbackStream} status={fallbackStatus} height={height} />
      )}
      {enabled && state === "loading" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 13,
            background: "rgba(4,48,122,.35)",
          }}
        >
          Loading 3D avatar &amp; voice… (first load downloads the voice model)
        </div>
      )}
      {enabled && state === "error" && (
        <div style={{ position: "absolute", bottom: 8, left: 8, fontSize: 11, color: "var(--dn-fg-muted)" }}>
          3D unavailable — using standard avatar
        </div>
      )}
    </div>
  );
});
