/**
 * Latency metrics sink. The video client measures the stages it alone can see (ASR / turn
 * detection and Tavus TTS render) and POSTs them here so they land in the SERVER (Render) logs
 * next to [tavus-llm-latency] — giving the whole pipeline in one place:
 *   ASR (speech end → transcript)  +  parse (our compose/gate)  +  TTS (text → replica audio).
 * Best-effort, non-sensitive (millisecond gaps + a truncated question); never blocks a turn.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Off-video client-side ASR telemetry (the experiment path): logged under its own tag so it can
  // be compared to the Tavus [nexusrep-latency] asrMs without spending video credits.
  if (body.kind === "asr") {
    console.info(
      "[nexusrep-asr]",
      JSON.stringify({
        engine: typeof body.engine === "string" ? body.engine : undefined,
        raw: typeof body.raw === "string" ? body.raw.slice(0, 80) : undefined,
        corrected: typeof body.corrected === "string" ? body.corrected.slice(0, 80) : undefined,
        corrections: Array.isArray(body.corrections) ? body.corrections.slice(0, 6) : undefined,
        finalizeMs: ms(body.finalizeMs), // last partial → final transcript (~ turn-detect + finalize)
        listenMs: ms(body.listenMs), // mic tap → final transcript (includes the doctor speaking)
        altCount: ms(body.altCount),
        onDevice: Boolean(body.onDevice),
      }),
    );
    return NextResponse.json({ ok: true });
  }
  console.info(
    "[nexusrep-latency]",
    JSON.stringify({
      sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 40) : undefined,
      question: typeof body.question === "string" ? body.question.slice(0, 80) : undefined,
      asrMs: ms(body.asrMs), // speech end → finalized transcript (Tavus ASR / turn detection)
      // asrMs split — attributes the 2-4s to STT vs turn-waiting (see VideoAgentStage.reportTurnLatency):
      partialCount: ms(body.partialCount), // # of user streaming partials this turn; 0 = Tavus gives us no user partials (can't see inside)
      sttTailAfterStopMs: ms(body.sttTailAfterStopMs), // VAD-stop → last partial: STT still transcribing after silence (STT-side)
      finalizeMs: ms(body.finalizeMs), // last partial → final transcript: dead time after last word (turn-confirm + finalize)
      transcriptToAudioMs: ms(body.transcriptToAudioMs), // HCP final transcript → replica audio
      firstVendorTextToAudioMs: ms(body.firstVendorTextToAudioMs), // first Tavus rep text event → audio
      finalVendorTextToAudioMs: ms(body.finalVendorTextToAudioMs), // final Tavus rep text event → audio
      repFinalUtteranceToAudioMs: ms(body.repFinalUtteranceToAudioMs),
      audioStartReason: typeof body.audioStartReason === "string" ? body.audioStartReason : null,
    }),
  );
  return NextResponse.json({ ok: true });
}
