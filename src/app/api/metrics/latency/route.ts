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
  console.info(
    "[nexusrep-latency]",
    JSON.stringify({
      sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 40) : undefined,
      question: typeof body.question === "string" ? body.question.slice(0, 80) : undefined,
      asrMs: ms(body.asrMs), // speech end → finalized transcript (Tavus ASR / turn detection)
      thinkToVoiceMs: ms(body.thinkToVoiceMs), // transcript → replica audio (our endpoint + Tavus TTS)
      transcriptToVoiceMs: ms(body.transcriptToVoiceMs), // rep text ready → replica audio (~Tavus TTS render)
    }),
  );
  return NextResponse.json({ ok: true });
}
