import { describe, expect, it } from "vitest";
import { runScriptedSession, type ScriptLine } from "@modules/realtime";
import { MockAvatarProvider, MockRealtimeProvider, MockVoiceProvider } from "@modules/vendors/mock";

const script: ScriptLine[] = [
  { text: "Hello, I'm the CardioNova AI representative." },
  { text: "Approved dosing line.", sourceId: "ans_dosing", slideId: "slide_dosing" },
  { text: "Thanks for your time." },
];

describe("A/V spike — scripted session through adapters", () => {
  it("drives start → speak(×N) → detail_aid → end and returns a playable timeline", async () => {
    const realtime = new MockRealtimeProvider();
    const voice = new MockVoiceProvider();
    const avatar = new MockAvatarProvider();

    const timeline = await runScriptedSession("session_spike", script, {
      realtime,
      voice,
      avatar,
      voiceConfig: { voiceId: "v1", style: "professional" },
    });

    const kinds = timeline.events.map((e) => e.kind);
    expect(kinds[0]).toBe("session_start");
    expect(kinds.at(-1)).toBe("session_end");
    expect(kinds.filter((k) => k === "speak")).toHaveLength(3);
    expect(kinds).toContain("detail_aid");
  });

  it("actually exercises the avatar adapter (boundary proof)", async () => {
    const avatar = new MockAvatarProvider();
    await runScriptedSession("session_spike", script, {
      realtime: new MockRealtimeProvider(),
      voice: new MockVoiceProvider(),
      avatar,
      voiceConfig: { voiceId: "v1" },
    });
    expect(avatar.spoken).toHaveLength(3);
    expect(avatar.slidesShown).toContain("slide_dosing");
  });

  it("reports the provider names so swaps are observable", async () => {
    const timeline = await runScriptedSession("s", script, {
      realtime: new MockRealtimeProvider(),
      voice: new MockVoiceProvider(),
      avatar: new MockAvatarProvider(),
      voiceConfig: { voiceId: "v1" },
    });
    expect(timeline.providers).toEqual({ realtime: "mock", voice: "mock", avatar: "mock" });
  });
});
