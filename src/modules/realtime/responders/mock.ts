import { sleep, type Responder } from "./types";

const CANNED =
  "Per the approved information, the maintenance dose is taken once daily following the loading dose. Titration follows the prescribing information after two weeks. I can show the dosing detail aid and the Important Safety Information whenever you're ready.";

/**
 * Browser baseline — the "passing the ball" feel: a noticeable pause before the
 * first word, then steady streaming. Real (it actually streams + speaks via the
 * browser voice), $0, always available. The latency floor to beat.
 */
export const mockResponder: Responder = {
  name: "mock",
  label: "Browser baseline (canned + browser TTS)",
  available: () => true,
  async *stream(_prompt, signal) {
    await sleep(650, signal); // simulated "fetching the answer" gap before speaking
    for (const word of CANNED.split(" ")) {
      if (signal?.aborted) return;
      yield word + " ";
      await sleep(45, signal);
    }
  },
};
