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

// Spoken pace of the replica/TTS: ~2.7 words/second (≈370 ms/word). This must track the ACTUAL
// speaking rate — the old 125 ms/word (8 wps) put the cue ~3× too early, so a mid/late cue fired
// while the rep was still on the first sentence. Kept a touch faster than estimateSpeechMs's 2.5 wps
// so the estimate lands a beat BEFORE the cue, not after.
const WORD_MS = 370;
// Switch a hair before the rep actually says the cue, so the slide is already up as they gesture at it.
const CUE_LEAD_MS = 350;

// The cue can sit anywhere in the answer: the LLM composer weaves it mid-answer (a sentence or two
// in), while the deterministic builder appends it at the end. Either way the deck switch is capped so
// it lands up front — the slide is for the WHOLE answer (the switch is gated on the answer actually
// being about it), so showing it a few seconds before the rep verbally names it is exactly right, and
// an end-appended cue never makes the doctor wait out the whole answer for the slide to move.
const MAX_CUE_DELAY_MS = 4000;

/** Milliseconds to wait (from when the rep STARTS speaking the answer) before switching the deck to
 *  the cued slide. Small for the normal early cue; capped so a stray late cue still switches up front
 *  rather than after the whole answer has been spoken. */
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
  return Math.max(450, Math.min(MAX_CUE_DELAY_MS, wordsBefore * WORD_MS - CUE_LEAD_MS));
}
