/**
 * Thin controller for the Stage 2 A/V spike. Assembles a FIXED approved script
 * from seeded approved content and runs it through the (mock) realtime/voice/
 * avatar adapters. No business logic here — orchestration lives in
 * runScriptedSession (@modules/realtime). No compliance gate at this stage.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { runScriptedSession, type ScriptLine } from "@modules/realtime";
import { getAvatarProvider, getRealtimeProvider, getVoiceProvider } from "@modules/vendors";

export async function POST(): Promise<NextResponse> {
  const c = await getContainer();

  // Approved opening detail assembled FROM THE ACTIVE BRAND PROFILE — greeting +
  // each seeded approved answer (with the slide it shows). Brand-agnostic: swap the
  // profile and the spike re-scripts itself. Body lines are publicly-disclosed facts
  // only; clinical specifics are still routed to Medical Information, never answered.
  const b = c.brand;
  const script: ScriptLine[] = [
    { text: b.persona.customGreeting },
    ...b.approvedAnswers.map((a) => ({ text: a.text, slideId: a.detailAidSlideId })),
    { text: `For questions on dosing, efficacy, or safety, I'll route you to Medical Information — ${b.displayName} is investigational and those details aren't something I can share.` },
    { text: "Thank you for your time. You can end the session whenever you're ready." },
  ];

  const timeline = await runScriptedSession(`${c.demo.sessionId}_spike`, script, {
    realtime: getRealtimeProvider(),
    voice: getVoiceProvider(),
    avatar: getAvatarProvider(),
    // No explicit voiceId — let the replica use its default voice (a real vendor rejects
    // an external voice combined with its auto-TTS; the mock ignores it either way).
    voiceConfig: { style: "professional" },
  });

  return NextResponse.json(timeline);
}
