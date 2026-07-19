/**
 * Rep voice via OpenAI TTS, used when the video replica is OFF (nicer than the browser Web Speech
 * voice). Generates the answer text in the selected tone + voice and caches the mp3 by
 * (voice, tone, text) — so repeated lines (greeting, ISI) are instant, unique answers generate
 * once. Fails safe: no / invalid OPENAI_API_KEY, empty text, or any error returns 204 and the
 * client falls back to the browser voice. (The LIVE Tavus video rep still uses the real replica.)
 */

import { NextResponse } from "next/server";
import { limited } from "@lib/rate-limit";
import { clampNum } from "@lib/env";
import { getContainerForUser } from "@lib/container";

export const dynamic = "force-dynamic";

/** OpenAI TTS generation timeout (whole clip, server-side). Default 20s; NEXUSREP_TTS_TIMEOUT_MS tunes. */
const TTS_TIMEOUT_MS = clampNum(process.env.NEXUSREP_TTS_TIMEOUT_MS, 20_000, 2_000, 60_000);

const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const TONE_INSTRUCTIONS: Record<string, string> = {
  professional: "Speak in a crisp, confident, professional tone — clear and to the point.",
  warm: "Speak in a warm, friendly, conversational tone — approachable and reassuring.",
  clinical: "Speak in a measured, precise, clinical tone — calm, factual, and understated.",
};

/** Process-wide cache of generated mp3s, keyed by (voice, tone, text). */
const clipCache = new Map<string, Buffer>();

function toneKey(t: unknown): keyof typeof TONE_INSTRUCTIONS {
  return t === "warm" || t === "clinical" ? t : "professional";
}

function audio(buf: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600", "Content-Length": String(buf.length) },
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const limit = limited(req, "tts");
  if (limit) return limit;
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; tone?: unknown; voice?: unknown; sessionId?: unknown };
  const text = (typeof body.text === "string" ? body.text : "").trim().slice(0, 1200); // bounded (answer + ISI)
  if (!text) return new NextResponse(null, { status: 204 });

  const tone = toneKey(body.tone);
  const voice = typeof body.voice === "string" && VOICES.includes(body.voice)
    ? body.voice
    : (process.env.OPENAI_TTS_VOICE && VOICES.includes(process.env.OPENAI_TTS_VOICE) ? process.env.OPENAI_TTS_VOICE : "echo");
  const key = `${voice}::${tone}::${text}`;

  const hit = clipCache.get(key);
  if (hit) return audio(hit);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !/^sk-[A-Za-z0-9_-]+$/.test(apiKey)) return new NextResponse(null, { status: 204 });

  try {
    const res = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice,
        input: text,
        instructions: TONE_INSTRUCTIONS[tone],
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!res.ok) return new NextResponse(null, { status: 204 }); // e.g. bad key → browser fallback
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return new NextResponse(null, { status: 204 });
    clipCache.set(key, buf);
    // Usage/cost: OpenAI TTS bills per character, and only on a REAL generation (cache hits above are
    // free). Best-effort into the default container's ledger — never blocks or breaks the audio reply.
    void getContainerForUser(null)
      .then((c) => c.usage.record({
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        vendor: "openai",
        operation: "tts",
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        chars: text.length,
      }))
      .catch(() => { /* observability must never break the flow it observes */ });
    return audio(buf);
  } catch {
    return new NextResponse(null, { status: 204 }); // network/timeout → browser fallback
  }
}
