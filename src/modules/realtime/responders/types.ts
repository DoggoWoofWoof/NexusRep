/**
 * Streaming responders for the Realtime Arena (internal model-eval tool).
 *
 * NOTE: the Arena is a latency/fluency benchmark, NOT the compliant HCP rep
 * path. Responders free-generate so we can feel streaming/barge-in/latency; the
 * production rep still answers only from approved blocks through the compliance
 * gate (see src/modules/realtime/orchestrator.ts).
 */

export const RESPONDER_SYSTEM =
  "You are an AI pharmaceutical representative talking with a healthcare professional. Answer concisely and professionally in 2–4 sentences. This is a latency/quality benchmark.";

export interface Responder {
  readonly name: string;
  readonly label: string;
  available(): boolean;
  /** Yield text deltas as they are produced. Stop promptly when `signal` aborts. */
  stream(prompt: string, signal?: AbortSignal): AsyncIterable<string>;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
