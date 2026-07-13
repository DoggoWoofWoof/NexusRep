/**
 * Cached tone-voice preview. Generates a short spoken clip of a fixed phrase in one of the three
 * rep tones (professional / warm / clinical) via OpenAI TTS, and caches it in memory keyed by
 * (tone, text). So the "hear this tone" preview in the Studio is a ONE-TIME generation cost, then
 * free instant playback — instead of a live video call per hover. Falls back gracefully: no /
 * invalid OpenAI key, or any error, returns 204 and the client uses the browser voice instead.
 *
 * This is a PREVIEW voice only. The live HCP conversation still speaks through the real Tavus
 * replica when the doctor opens the video rep.
 */

import { NextResponse } from "next/server";
import { isTtsVoice } from "@lib/tts-voices";

export const dynamic = "force-dynamic";

const DEFAULT_PHRASE = "Hi — this is how your rep sounds when it speaks with a doctor.";

const TONE_INSTRUCTIONS: Record<string, string> = {
  professional: "Speak in a crisp, confident, professional tone — clear and to the point, minimal filler.",
  warm: "Speak in a warm, friendly, conversational tone — approachable and reassuring.",
  clinical: "Speak in a measured, precise, clinical tone — calm, factual, and understated.",
};

/** Process-wide cache: one small mp3 per (tone, text). ~3 clips total for the default phrase. */
const clipCache = new Map<string, Buffer>();

function toneKey(t: string | null): keyof typeof TONE_INSTRUCTIONS {
  return t === "warm" || t === "clinical" ? t : "professional";
}

function audio(buf: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "Content-Length": String(buf.length) },
  });
}

export async function GET(req: Request): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const tone = toneKey(searchParams.get("tone"));
  // Cap keeps clips short (~30s max) and bounds the injection/cost surface.
  const text = (searchParams.get("text") || DEFAULT_PHRASE).slice(0, 400);
  // Per-name voice: the client maps the agent name → a stable voice; we validate it against the
  // allowed set (else the configured/default voice). Same (voice, tone, text) → same cached clip.
  const qVoice = searchParams.get("voice");
  const voice = isTtsVoice(qVoice) ? qVoice : (process.env.OPENAI_TTS_VOICE || "alloy");
  const key = `${voice}::${tone}::${text}`;

  const hit = clipCache.get(key);
  if (hit) return audio(hit);

  const apiKey = process.env.OPENAI_API_KEY;
  // No usable key → tell the client to fall back to the browser voice (204, no body).
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
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return new NextResponse(null, { status: 204 }); // e.g. bad key → browser fallback
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return new NextResponse(null, { status: 204 });
    clipCache.set(key, buf); // one-time cost — every later request for this tone is instant
    return audio(buf);
  } catch {
    return new NextResponse(null, { status: 204 }); // network/timeout → browser fallback
  }
}
