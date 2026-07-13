/**
 * Shared spec for the agent-gallery voice preview — imported by the client (hover playback +
 * OpenAI fallback), the /api/realtime/agents/preview route, and the Tavus adapter, so the spoken
 * script and the per-agent voice are IDENTICAL everywhere. The primary preview is a Tavus-rendered
 * clip of the replica speaking this script in its OWN voice; OpenAI TTS is an opt-in "synthetic
 * voice" alternative, and the agent's stock clip audio is the while-rendering fallback.
 */

export const PREVIEW_TONES = ["professional", "warm", "clinical"] as const;
export type PreviewTone = (typeof PREVIEW_TONES)[number];

export function toneLabel(tone?: string): string {
  return tone === "warm" ? "warm" : tone === "clinical" ? "clinical" : "professional";
}

/** Clean gallery name for the spoken intro: just the person, no setting/version/"deprecated". */
export function spokenName(name: string): string {
  return name.replace(/\(.*?\)/g, "").split(/\s[-–—]\s/)[0]!.replace(/deprecated/gi, "").trim() || name;
}

/**
 * The intro the agent speaks on hover. Three beats: who they are + which tone, an out (try a
 * different tone or another agent), and the call to select. No internal jargon ("replica"/"API").
 */
export function previewScript(name: string, tone?: string): string {
  const who = spokenName(name);
  return `Hi, I'm ${who}. This is my ${toneLabel(tone)} voice. If this tone isn't quite right, you can try a different tone or pick another agent. If you like it, select me and move to the next step.`;
}

/** The OpenAI TTS voices the /api/voice/speak route accepts (the synthetic-voice fallback). */
export const PREVIEW_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] as const;

/** Deterministic default synthetic voice for an agent (stable: same name → same voice). */
export function voiceForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PREVIEW_VOICES[h % PREVIEW_VOICES.length]!;
}

/** Deterministic Tavus video name for a rendered preview, so a given (agent, tone) is generated
 *  at most once ever — the route looks it up before spending credits on a new render. */
export function previewVideoName(agentId: string, tone?: string): string {
  return `nexusrep-preview-${agentId}-${toneLabel(tone)}`;
}
