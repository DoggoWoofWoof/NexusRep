/**
 * Shared slide-cue TIMING so the doctor preview (HcpExperience) and the training rehearsal
 * (StudioScreen) switch the detail-aid deck IDENTICALLY: not a jump at the first word, but right
 * when the rep reaches the spoken cue ("…on the mechanism slide"). The backend already gates WHETHER
 * to switch (only when the answer cues a slide — see orchestrator.cuesASlide); this decides WHEN.
 *
 * Estimate: find the cue phrase in the answer, count the words before it, and delay ~125ms/word from
 * when the rep starts speaking — clamped so it never fires instantly or drags. If no cue phrase is
 * found (shouldn't happen once the backend gated on one), fall back to a small fixed lead-in.
 */

export const SLIDE_CUE_DELAY_MS = 850;

const CUE_MARKERS = [
  "you can see",
  "you can look",
  "i've pulled up",
  "i have pulled up",
  "take a look",
  "have a look",
  "on your screen",
  "on screen",
  "shown on",
  "available on screen",
  "laid out on",
  "let's move to",
  "let's go to",
  "we'll start with",
  "i'll use",
  "i'd show",
  "i'm showing",
  "pulled up",
];

/** Does this (possibly partial) transcript contain a slide cue yet? Used on the VIDEO path to switch
 *  the deck the instant the replica's STREAMING transcript reaches the cue (exact, not estimated). */
export function hasSlideCue(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\bslides?\b/.test(lower) || CUE_MARKERS.some((m) => lower.includes(m));
}

/** Milliseconds to wait (from when the rep STARTS speaking the answer) before switching the deck to
 *  the cued slide, so the switch lands as the rep says it. */
export function slideCueDelayMs(text?: string): number {
  const body = text?.trim();
  if (!body) return SLIDE_CUE_DELAY_MS;
  const lower = body.toLowerCase();
  const idx = CUE_MARKERS
    .map((m) => lower.indexOf(m))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (idx == null) return SLIDE_CUE_DELAY_MS;
  const wordsBefore = body.slice(0, idx).split(/\s+/).filter(Boolean).length;
  return Math.min(1800, Math.max(550, wordsBefore * 125));
}
