/**
 * Estimate the on-screen duration (ms) of a spoken rep segment, for pacing a multi-segment overview
 * walk and the caption/turn timing. Floored + capped so segments leave a natural gap. This is
 * DISTINCT from browser-speech's estimateSpeechMs (a different formula tuned for TTS chunk timing) —
 * the doctor preview and the overview route both used this identical copy inline.
 */
export function estimateSegmentSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(5500, Math.min(28000, words * 360));
}
