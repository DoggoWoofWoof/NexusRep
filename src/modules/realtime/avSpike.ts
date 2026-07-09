/**
 * Stage 2 — A/V spike (brief §21 Stage 2). End-to-end "talking twin" proof:
 * a FIXED approved script is spoken through the provider adapters and a fixed
 * detail aid is shown. There is intentionally NO compliance/retrieval here yet —
 * this stage only proves the realtime/voice/avatar adapter boundary works and
 * can drive a browser experience.
 *
 *   realtime.startSession → for each line: voice.synthesize → avatar.speak
 *                          (+ avatar.showDetailAid when the line has a slide)
 *                        → realtime.endSession / avatar.endAvatar
 *
 * The function is provider-agnostic: swap the mocks for GPT Realtime / Tavus and
 * the orchestration is unchanged.
 */

import type {
  AvatarProvider,
  RealtimeProvider,
  VoiceConfig,
  VoiceProvider,
} from "@modules/vendors";

export interface ScriptLine {
  text: string;
  /** Approved-answer id this line came from (provenance only — not a compliance check yet). */
  sourceId?: string;
  /** Detail-aid slide to display while speaking this line. */
  slideId?: string;
}

export type SpikeEventKind = "session_start" | "speak" | "detail_aid" | "session_end";

export interface SpikeEvent {
  kind: SpikeEventKind;
  text?: string;
  audioRef?: string;
  durationMs?: number;
  slideId?: string;
  sourceId?: string;
}

export interface SpikeTimeline {
  providers: { realtime: string; voice: string; avatar: string };
  events: SpikeEvent[];
  totalDurationMs: number;
}

export interface SpikeDeps {
  realtime: RealtimeProvider;
  voice: VoiceProvider;
  avatar: AvatarProvider;
  voiceConfig: VoiceConfig;
}

/** Drive a fixed approved script through the adapters and return a playable timeline. */
export async function runScriptedSession(
  sessionId: string,
  script: ScriptLine[],
  deps: SpikeDeps,
): Promise<SpikeTimeline> {
  const events: SpikeEvent[] = [];
  let totalDurationMs = 0;

  await deps.realtime.startSession({
    sessionId,
    systemPrompt: "Fixed approved A/V spike — no generation.",
    tools: [],
    voice: deps.voiceConfig,
  });
  await deps.avatar.startAvatar({ avatarId: "spike-avatar" });
  events.push({ kind: "session_start" });

  for (const line of script) {
    const audio = await deps.voice.synthesize(line.text, deps.voiceConfig);
    await deps.avatar.speak({ audioRef: audio.ref });
    events.push({
      kind: "speak",
      text: line.text,
      audioRef: audio.ref,
      durationMs: audio.durationMs,
      sourceId: line.sourceId,
    });
    totalDurationMs += audio.durationMs;

    if (line.slideId) {
      await deps.avatar.showDetailAid(line.slideId);
      events.push({ kind: "detail_aid", slideId: line.slideId });
    }
  }

  await deps.avatar.endAvatar();
  await deps.realtime.endSession();
  events.push({ kind: "session_end" });

  return {
    providers: { realtime: deps.realtime.name, voice: deps.voice.name, avatar: deps.avatar.name },
    events,
    totalDurationMs,
  };
}
