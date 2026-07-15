"use client";

import { useRef } from "react";
import { slideCueDelayMs } from "@lib/slide-cue";

/**
 * Times the detail-aid slide switch to WHEN the rep speaks the cue. On the video path we switch the
 * INSTANT the replica's streaming transcript reaches the cue (the transport calls `onSlideCue`) —
 * exact, not estimated. Off-video (no transcript), or as a safety net if the cue never streams, we
 * fall back to the word-position estimate. Shared by the doctor preview AND the training rehearsal
 * (ask AND coach) so every surface switches slides identically.
 *
 * Nothing is armed unless the backend sent a slide id (it only does when the answer cues one), so a
 * cue-less answer never switches.
 */
export function useCuedSlide(setSlide: (id: string) => void) {
  const armedRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const clearTimer = () => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
  };

  /** Arm the slide for the rep turn now being spoken. `live` = a streaming transcript will report the
   *  cue via onSlideCue (video); we still set a generous safety timer in case it never does. */
  const cueSlide = (id?: string | null, spokenText?: string, live = false) => {
    if (!id) return;
    clearTimer();
    armedRef.current = id;
    const estimate = slideCueDelayMs(spokenText);
    // Live: the exact switch comes from onSlideCue; this timer only fires if the cue never streamed.
    const delay = live ? Math.max(estimate + 1500, 3000) : estimate;
    timerRef.current = window.setTimeout(() => {
      if (armedRef.current === id) { armedRef.current = null; setSlide(id); }
    }, delay);
  };

  /** The replica's streaming transcript just reached the cue → switch the armed slide NOW. */
  const onSlideCue = () => {
    const id = armedRef.current;
    if (!id) return;
    clearTimer();
    armedRef.current = null;
    setSlide(id);
  };

  /** Drop any pending switch (session close / unmount) so a stale slide never lands afterwards. */
  const cancel = () => { clearTimer(); armedRef.current = null; };

  return { cueSlide, onSlideCue, cancel };
}
