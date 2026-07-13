/**
 * Shared spec for the agent voice preview + the video-off voice — imported by the client, the
 * /api/realtime/agents/preview route, and the Tavus adapter, so the spoken script and the voice
 * list are identical everywhere. Tone is deliberately ABSENT here: it's a coaching concern (a
 * rule you can add in Training), not a voice knob — so there is ONE script, same for every agent
 * and every render, and only the VOICE ever changes.
 */

/** Clean gallery name for the spoken intro: just the person, no setting/version/"deprecated". */
export function spokenName(name: string): string {
  return name.replace(/\(.*?\)/g, "").split(/\s[-–—]\s/)[0]!.replace(/deprecated/gi, "").trim() || name;
}

/** The single intro the agent speaks in a preview clip / voice sample — no tone, no jargon
 *  ("replica"/"API"). */
export function previewScript(name: string): string {
  const who = spokenName(name);
  return `Hi, I'm ${who}. I could be the face and voice of your AI rep. If you'd like that, select me and move to the next step.`;
}

/** OpenAI TTS voices selectable for the video-off rep voice — curated to the most natural /
 *  human-like ones (the harsher/robotic alloy, onyx, fable are dropped). OpenAI's speech API has
 *  no "Aria"-style named voice; these are the full natural set it offers. `echo` is the default. */
export const PREVIEW_VOICES = ["echo", "nova", "shimmer", "sage", "coral", "ash", "ballad"] as const;

/** Default video-off voice when the user hasn't picked one (also the /api/voice/speak fallback). */
export const DEFAULT_VOICE = "echo";

/** Deterministic default synthetic voice for an agent (stable: same name → same voice). */
export function voiceForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PREVIEW_VOICES[h % PREVIEW_VOICES.length]!;
}

/** Deterministic Tavus video name for a rendered preview — keyed by AGENT only (no tone), so a
 *  given agent is rendered at most once ever; the route looks it up before spending credits. */
export function previewVideoName(agentId: string): string {
  return `nexusrep-preview-${agentId}`;
}
