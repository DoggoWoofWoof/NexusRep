"use client";

import { useRef } from "react";
import { slideCueDelayMs } from "@lib/slide-cue";

/**
 * Times the detail-aid slide switch to WHEN the rep speaks the cue, anchored to the moment the
 * replica's AUDIO actually starts — not when we queued the answer, and not the replica's streaming
 * TEXT (which, with a custom LLM, arrives seconds before it's spoken and switched the deck far too
 * early). Shared by the doctor preview AND the training rehearsal (ask AND coach) so every surface
 * switches identically.
 *
 * Off-video (live=false): the TTS begins right away, so the cue timer starts on arm.
 * On video (live=true): the replica speaks after a TTS-render delay, so we wait for onRepAudioStart
 * (the vendor's "started speaking" event) and count the cue offset from there. A latch covers the
 * race where audio-start fires just before the slide is armed.
 *
 * Nothing is armed unless the backend sent a slide id (it only does when the answer cues one), so a
 * cue-less answer never switches.
 */
export function useCuedSlide(setSlide: (id: string) => void) {
  const armedRef = useRef<{ id: string; text: string } | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioLatchRef = useRef(false); // video: audio-start fired before the slide was armed
  const clearTimer = () => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const startTimer = (id: string, text: string) => {
    clearTimer();
    audioLatchRef.current = false;
    timerRef.current = window.setTimeout(() => {
      if (armedRef.current?.id === id) { armedRef.current = null; setSlide(id); }
    }, slideCueDelayMs(text));
  };

  /** Arm the slide for the turn now being delivered. Off-video → anchor the cue timer now; on video
   *  → wait for onRepAudioStart (unless it already fired this turn). */
  const cueSlide = (id?: string | null, spokenText?: string, live = false) => {
    if (!id) return;
    clearTimer();
    const text = spokenText ?? "";
    armedRef.current = { id, text };
    if (!live || audioLatchRef.current) startTimer(id, text);
  };

  /** The replica's audio just STARTED — anchor the video cue offset from here (the switch lands as
   *  the rep reaches the spoken cue, ~slideCueDelayMs into the answer). */
  const onRepAudioStart = () => {
    if (armedRef.current && !timerRef.current) startTimer(armedRef.current.id, armedRef.current.text);
    else if (!armedRef.current) audioLatchRef.current = true; // arm hasn't happened yet — latch it
  };

  /** Drop any pending switch (session close / unmount) so a stale slide never lands afterwards. */
  const cancel = () => { clearTimer(); armedRef.current = null; audioLatchRef.current = false; };

  return { cueSlide, onRepAudioStart, cancel };
}
