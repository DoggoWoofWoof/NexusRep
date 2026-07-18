/**
 * Speaking-rate estimates for pacing captions, the overview walk, and turn-done / barge-in windows.
 *
 * There are TWO real rep voices and they speak at MEASURABLY DIFFERENT rates, so pacing must not use
 * one number for both. Measured 2026-07-18 (scripts in the repo history; see docs/WALKTHROUGH.md):
 *
 *  - TTS_MS_PER_WORD — the OpenAI/browser "video-off" rep voice (gpt-4o-mini-tts / echo,
 *    professional). Measured ≈408 ms/word over a representative 165-word corpus (drug names included).
 *  - REPLICA_MS_PER_WORD — the LIVE Tavus video replica (Cartesia sonic-3 @ speed 1.0). Measured
 *    ≈301 ms/word from a rendered clip — a genuinely FAST voice. A live turn ALSO carries startup
 *    latency before the first word, so a replica turn is REPLICA_STARTUP_MS + words×rate, NOT one
 *    inflated per-word number: the previous single slope (430) folded startup into the rate and thus
 *    over-estimated long lines. (Pure rate ≈301; using 305 keeps a hair of headroom.)
 *  - REPLICA_STARTUP_MS — the replica's join→first-word latency (network + TTS spin-up).
 */
export const TTS_MS_PER_WORD = 400;
export const REPLICA_MS_PER_WORD = 305;
export const REPLICA_STARTUP_MS = 1_200;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Wall-clock ms for a LIVE Tavus replica to finish a turn: startup latency + speaking time. Paces the
 * video-on overview walk (so the next segment doesn't fire while the replica is still talking) and is
 * the base for VideoAgentStage's turn-done / barge-in safety windows (which add their own tails).
 * Floored (a short line still costs the startup) and capped.
 */
export function estimateReplicaTurnMs(text: string): number {
  return Math.min(45_000, Math.max(2_400, REPLICA_STARTUP_MS + wordCount(text) * REPLICA_MS_PER_WORD));
}

/**
 * Overview-segment transcript timestamp spacing (server-side, cosmetic ordering of the review
 * transcript). The overview is a replica walk, so it reuses the replica turn estimate, floored so a
 * run of short segments doesn't collapse onto the same second. NOT used for live pacing — that is
 * estimateReplicaTurnMs (video-on) or the voice's own onend (video-off).
 */
export function estimateSegmentSpeechMs(text: string): number {
  return Math.max(5_500, Math.min(28_000, estimateReplicaTurnMs(text)));
}
