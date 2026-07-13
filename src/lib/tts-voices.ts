/**
 * OpenAI TTS voice ids + a STABLE name→voice mapping, so the same agent name always previews in
 * the same voice (and different names mostly differ). Shared by the client (which picks the voice
 * from the agent's name) and the /api/voice/preview route (which validates + generates). No
 * runtime deps, so it imports cleanly on both sides.
 */

export const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

/** Deterministic name → voice (same name → same voice). Empty name → the neutral default. */
export function voiceForName(name: string): TtsVoice {
  const n = (name || "").trim().toLowerCase();
  if (!n) return "alloy";
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return TTS_VOICES[h % TTS_VOICES.length]!;
}

export function isTtsVoice(v: string | null | undefined): v is TtsVoice {
  return !!v && (TTS_VOICES as readonly string[]).includes(v);
}
