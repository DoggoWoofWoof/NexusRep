/**
 * Slide-cue TIMING + the always-reference-the-slide gate — the doctor-transcript regressions:
 *  1. The deck switched long BEFORE the rep reached the cue (or never), because the estimate was
 *     ~3× too fast and capped at 1.8s, so a mid/late cue fired while the rep was still on sentence 1.
 *  2. The rep sometimes never mentioned an available slide, so no cue → no switch at all.
 */

import { describe, expect, it } from "vitest";
import { hasSlideCue, slideCueDelayMs, SLIDE_CUE_DELAY_MS } from "@lib/slide-cue";
import { createContainer } from "@lib/container";
import { cuesASlide } from "@modules/realtime/orchestrator";
import type { GroundedComposer } from "@modules/content";

describe("slideCueDelayMs — lands the switch AS the rep reaches the cue, not seconds early", () => {
  it("empty / cue-less text falls back to the small fixed lead-in", () => {
    expect(slideCueDelayMs("")).toBe(SLIDE_CUE_DELAY_MS);
    expect(slideCueDelayMs("An answer with no slide cue at all.")).toBe(SLIDE_CUE_DELAY_MS);
  });

  it("a cue near the START switches almost immediately", () => {
    // "You can see this …" is the first phrase — only a small lead.
    expect(slideCueDelayMs("You can see this on the mechanism slide.")).toBeLessThan(1000);
  });

  it("a LATE cue in a long answer waits many seconds — the old 1.8s cap is gone", () => {
    // ~45 words before the cue → well past the old 1800ms ceiling.
    const long =
      "LIBREXIA AF is a Phase 3 randomized double-blind active-controlled trial comparing milvexian " +
      "to apixaban in roughly fifteen thousand five hundred participants with atrial fibrillation or " +
      "atrial flutter, with topline data expected soon, and you can see the trial design on the AF slide.";
    const delay = slideCueDelayMs(long);
    expect(delay).toBeGreaterThan(6000); // late cue → late switch (was capped at 1800)
    expect(delay).toBeLessThan(20001); // still clamped to something sane
  });

  it("scales with cue position — a later cue waits longer than an earlier one", () => {
    const early = slideCueDelayMs("You can see this on the mechanism slide as I explain the enzyme.");
    const late = slideCueDelayMs(
      "Milvexian is a selective Factor XIa inhibitor that blocks a key enzyme in the coagulation " +
        "cascade to reduce abnormal clot formation, and you can see this on the mechanism slide.",
    );
    expect(late).toBeGreaterThan(early);
  });
});

describe("hasSlideCue — detects the cue anywhere in the (untruncated) streaming transcript", () => {
  it("matches a bare 'slide' and the cue markers", () => {
    expect(hasSlideCue("Let's move to the atrial fibrillation slide.")).toBe(true);
    expect(hasSlideCue("I've pulled up the development status page.")).toBe(true); // "pulled up" marker
  });

  it("still matches when the cue sits far past the first 80 chars (the truncation regression)", () => {
    const longWithLateCue =
      "LIBREXIA AF is a Phase 3 randomized double-blind active-controlled trial comparing milvexian to " +
      "apixaban in participants with atrial fibrillation, and you can see the trial design details on the AF slide.";
    expect(longWithLateCue.length).toBeGreaterThan(120);
    expect(longWithLateCue.slice(0, 80)).not.toMatch(/slide/i); // the OLD 80-char window saw no cue
    expect(hasSlideCue(longWithLateCue)).toBe(true); // the full transcript does
  });

  it("finds no cue in a plain answer", () => {
    expect(hasSlideCue("Milvexian is being studied at 25 mg twice daily.")).toBe(false);
  });
});

describe("the rep ALWAYS references an available slide (so the deck reliably switches)", () => {
  it("weaves a slide cue even when the composer forgets to mention it", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    // A grounded answer that (deliberately) never references the slide — the exact failure from the
    // live transcript, where a mechanism/stroke answer omitted the slide and the deck never moved.
    const cueLessComposer: GroundedComposer = {
      name: "cue-less-test-composer",
      available: () => true,
      compose: async ({ blocks }) => ({ text: `Here's what I can share. ${blocks[0]!.text}`, latencyMs: 1 }),
    };
    const out = await c.orchestrator.handleTurn(
      {
        sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
        indication: c.demo.indication, market: c.demo.market,
        investigational: c.demo.investigational, text: "What is LIBREXIA?",
      },
      { composer: cueLessComposer },
    );
    // A slide exists for this answer → the rep now names it, so the cue is present AND the deck switches.
    expect(cuesASlide(out.responseText)).toBe(true);
    expect(out.detailAidSlideId).toBeTruthy();
  });
});
