/**
 * Routing robustness — the transcript showed a single garbled word flipping the whole answer
 * ("clinical PROGRAM studying" → answered vs "clinical VIEW studying" → bounced to contact). These
 * lock down that paraphrases of the SAME public question route CONSISTENTLY (not medical-info
 * bounce), that genuine clinical specifics (dose/safety) still route away, that short affirmations
 * continue the prior topic, and that the contact answer can't trap follow-ups in a loop.
 *
 * Vitest uses the keyword classifier + lexical retrieval (no LLM) — exactly the fragile path the
 * transcript exposed, so these guard the deterministic floor. The LLM path is validated live.
 */

import { describe, it, expect } from "vitest";
import { createContainer } from "@lib/container";
import { isOverviewPrompt } from "@modules/content/overviewPrompt";
import { cuesASlide } from "@modules/realtime/orchestrator";
import type { ApprovedAnswer, GroundedComposer } from "@modules/content";

type Ctr = Awaited<ReturnType<typeof createContainer>>;
const ctxFor = (c: Ctr, text: string) => ({
  sessionId: c.demo.sessionId, hcpId: c.demo.hcpId, audience: c.demo.audience,
  indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text,
});
const BOUNCE = /detailed medical question|connect you with (our|someone)/i;

describe("routing robustness — no one-word flips", () => {
  it("program / trial / 'what is X studying' paraphrases all route consistently (never a contact bounce)", async () => {
    const c = await createContainer();
    const paraphrases = [
      "What is the clinical program studying?",
      "What is the clinical view I'm studying?", // the transcript's garbled twin — must NOT flip
      "what does the program study",
      "what is the trial studying",
      "what are the studies looking at",
      "what's being investigated in the program",
    ];
    const routes = new Set<string>();
    for (const q of paraphrases) {
      const { output } = await c.conversation.turn(ctxFor(c, q));
      routes.add(output.route);
      // The bug: these bounced to Medical Information / contact on one word. Never again.
      expect(output.route, q).not.toBe("medical_information");
      expect(output.responseText, q).not.toMatch(BOUNCE);
    }
    // All the paraphrases resolve to the SAME route — no flipping on a single word.
    expect(routes.size, `routes seen: ${[...routes]}`).toBe(1);
    expect([...routes][0]).toBe("approved_answer");
  }, 60_000);

  it("still routes GENUINE clinical specifics (dose / administration) away for an investigational drug", async () => {
    const c = await createContainer();
    for (const q of ["what dose should I use", "how much should I give", "how is it administered"]) {
      const { output } = await c.conversation.turn(ctxFor(c, q));
      expect(output.route, q).toBe("medical_information");
    }
  }, 60_000);

  it("live voice fast-classifies only low-risk public information, never clinical specifics", async () => {
    const c = await createContainer();
    const s1 = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.conversation.turn({ ...ctxFor(c, "How does Milvexian work?"), sessionId: s1.id }, { speculativeCompose: true, suppressRelatedSlide: true });
    const fast = (await c.audit.forSession(s1.id)).find((e) => e.type === "classification");
    expect(fast?.payload.fastPath).toBe("live_public_info");

    const s2 = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.conversation.turn({ ...ctxFor(c, "What dose should I use?"), sessionId: s2.id }, { speculativeCompose: true, suppressRelatedSlide: true });
    const risky = (await c.audit.forSession(s2.id)).find((e) => e.type === "classification");
    expect(risky?.payload.fastPath).toBeUndefined();
  }, 60_000);

  it("a short affirmation continues the PRIOR topic instead of bouncing", async () => {
    const c = await createContainer();
    await c.conversation.turn(ctxFor(c, "tell me about the LIBREXIA program")); // establishes topic
    const { output } = await c.conversation.turn(ctxFor(c, "yeah sure")); // pure affirmation follow-up
    expect(output.route).toBe("approved_answer");
    expect(output.responseText).not.toMatch(BOUNCE);
    expect(output.responseText.toLowerCase()).toMatch(/librexia|program|stroke|coronary|atrial|milvexian|factor/);
  }, 60_000);

  it("a one-word live voice cue like 'Program.' still resolves to the approved LIBREXIA answer", async () => {
    const c = await createContainer();
    const { output } = await c.conversation.turn(ctxFor(c, "Program."));
    expect(output.route).toBe("approved_answer");
    expect(output.responseText).not.toMatch(BOUNCE);
    expect(output.responseText.toLowerCase()).toMatch(/librexia|program|trial/);
    expect(output.detailAidSlideId).toBe("slide_program");
  }, 60_000);

  it("mechanism-rationale phrasing answers from MOA content, not Medical Information", async () => {
    const c = await createContainer();
    for (const q of [
      "Why focus on the clotting cascade rather than the usual pathway?",
      "Why focus on the clotting cascade rather than the usual path",
    ]) {
      const { output } = await c.conversation.turn(ctxFor(c, q));
      expect(output.route, q).toBe("approved_answer");
      expect(output.responseText, q).not.toMatch(BOUNCE);
      expect(output.responseText.toLowerCase(), q).toMatch(/factor xia|fxia|coagulation|clot/);
      expect(output.detailAidSlideId, q).toBe("slide_moa");
    }
  }, 60_000);

  it("accepting an offered next slide follows that offered source instead of repeating the same one", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.conversation.turn({
      ...ctxFor(c, "What is the LIBREXIA program?"),
      sessionId: s.id,
    });
    const prior = await c.audit.forSession(s.id);
    const offered = [...prior]
      .reverse()
      .find((e) => e.type === "response_output" && typeof e.payload.suggestedFollowUpSlideId === "string");
    expect(offered?.payload.suggestedFollowUpSlideId).toBeTruthy();

    const { output } = await c.conversation.turn({
      ...ctxFor(c, "Yeah. Sure did."),
      sessionId: s.id,
    });
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe(offered!.payload.suggestedFollowUpSlideId);
  }, 60_000);

  it("the contact answer does not trap follow-ups in a loop", async () => {
    const c = await createContainer();
    await c.conversation.turn(ctxFor(c, "how does milvexian work")); // real topic
    await c.conversation.turn(ctxFor(c, "how do I reach a person")); // → contact/handoff
    const { output } = await c.conversation.turn(ctxFor(c, "show me the slides")); // follow-up
    // Must bias back to a REAL topic's slide, not re-bounce to the contact answer forever.
    expect(output.responseText.toLowerCase()).not.toMatch(/routed to medical information or an msl/);
  }, 60_000);

  it("live voice gives the composer a focused context window without starving it", async () => {
    const c = await createContainer();
    const seen: number[] = [];
    const composer: GroundedComposer = {
      name: "spy",
      available: () => true,
      async compose({ blocks }: { blocks: ApprovedAnswer[] }) {
        seen.push(blocks.length);
        return { text: `${blocks[0]!.text} You can see this on the mechanism of action slide.`, latencyMs: 1 };
      },
    };
    const out = await c.orchestrator.handleTurn(ctxFor(c, "How does Milvexian work?"), {
      composer,
      suppressRelatedSlide: true,
    });

    expect(out.route).toBe("approved_answer");
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(2);
    expect(out.sourceIds.length).toBeGreaterThan(0);
    expect(out.sourceIds.length).toBeLessThanOrEqual(2);
  }, 60_000);

  it("repairs a truncated LLM answer before falling back to deterministic approved copy", async () => {
    const c = await createContainer();
    let calls = 0;
    const composer: GroundedComposer = {
      name: "truncating",
      available: () => true,
      async compose({ blocks }) {
        calls += 1;
        if (calls === 1) return { text: "Milvexian is an investigational,", latencyMs: 1, truncated: true };
        return { text: `${blocks[0]!.text} You can see this on the mechanism of action slide.`, latencyMs: 1 };
      },
    };
    const out = await c.orchestrator.handleTurn(ctxFor(c, "How does Milvexian work?"), {
      composer,
      suppressRelatedSlide: true,
    });
    const audit = await c.audit.forSession(c.demo.sessionId);
    const successEvent = [...audit].reverse().find((e) => e.type === "response_validation" && e.payload.action === "composer_success");

    expect(out.route).toBe("approved_answer");
    expect(out.responseText).not.toBe("Milvexian is an investigational,");
    expect(out.responseText).toMatch(/Factor XIa|FXIa/i);
    expect(calls).toBe(2);
    expect(successEvent?.payload.repair).toBe(true);
  }, 60_000);
});

describe("overview-prompt detection", () => {
  const lex = { productTerms: ["milvexian", "librexia"] };
  it.each([
    "show me the slides",
    "can you show me the slides",
    "walk me through the deck",
    "give me an overview of milvexian",
    "quick overview",
    "pull up the presentation",
  ])("treats %j as an overview/slide request", (q) => {
    expect(isOverviewPrompt(q, lex)).toBe(true);
  });
  it.each([
    "how does milvexian work",
    "what dose should I use",
    "is it better than apixaban",
    "what are the side effects",
  ])("treats %j as a normal question, not an overview", (q) => {
    expect(isOverviewPrompt(q, lex)).toBe(false);
  });
});

describe("slide switch is gated on a spoken cue (no cue → no switch)", () => {
  it.each([
    "You can see this on the mechanism slide I've put up on your screen.",
    "Take a look at the LIBREXIA program slide.",
    "I've pulled up the development status slide.",
    "Let's move to the atrial fibrillation slide.",
  ])("detects a slide cue in %j", (t) => expect(cuesASlide(t)).toBe(true));

  it.each([
    "Milvexian is an investigational oral Factor XIa inhibitor being studied as an anticoagulant.",
    "It is being developed by Johnson & Johnson in collaboration with Bristol Myers Squibb.",
    "That's a detailed medical question. I can connect you with our medical information team.",
  ])("finds NO cue (so no switch) in %j", (t) => expect(cuesASlide(t)).toBe(false));

  it("a real approved answer both cues a slide AND carries a detailAidSlideId to switch to", async () => {
    const c = await createContainer();
    const { output } = await c.conversation.turn({
      sessionId: c.demo.sessionId, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational,
      text: "how does milvexian work",
    });
    expect(output.route).toBe("approved_answer");
    expect(cuesASlide(output.responseText)).toBe(true);
    expect(output.detailAidSlideId).toBeTruthy();
  }, 60_000);
});

describe("trial specificity — name a trial, get THAT trial's slide (not the program slide)", () => {
  it("'what is the LIBREXIA stroke trial' leads with the STROKE answer + STROKE slide", async () => {
    const c = await createContainer();
    const { output } = await c.conversation.turn(ctxFor(c, "what is the LIBREXIA stroke trial"));
    expect(output.route).toBe("approved_answer");
    expect(output.responseText.toLowerCase()).toMatch(/stroke/);
    expect(output.detailAidSlideId).toBe("slide_stroke"); // was slide_program (the transcript bug)
  }, 60_000);

  it("a bare affirmation after a stroke question STAYS on stroke (the trial anchors the follow-up)", async () => {
    const c = await createContainer();
    await c.conversation.turn(ctxFor(c, "what is the LIBREXIA stroke trial"));
    const { output } = await c.conversation.turn(ctxFor(c, "yeah sure"));
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_stroke"); // not slide_program / a generic indications slide
    expect(output.responseText.toLowerCase()).toMatch(/stroke/);
  }, 60_000);

  it("naming NO trial (the general program) still shows the PROGRAM slide", async () => {
    const c = await createContainer();
    const { output } = await c.conversation.turn(ctxFor(c, "what is the LIBREXIA program"));
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_program");
  }, 60_000);

  it("the AF trial promotes the AF slide (stroke matcher doesn't steal it)", async () => {
    const c = await createContainer();
    const { output } = await c.conversation.turn(ctxFor(c, "tell me about the atrial fibrillation trial"));
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_af");
  }, 60_000);

  it("LIBREXIA AF by acronym promotes the AF slide even when retrieval likes the generic program", async () => {
    const c = await createContainer();
    const { output } = await c.conversation.turn(ctxFor(c, "Tell me about LIBREXIA AF."));
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_af");
    expect(output.responseText.toLowerCase()).toMatch(/atrial|af|fibrillation/);
  }, 60_000);

  it("re-answering a stroke question WITH coaching keeps the STROKE slide (coaching reinforces, never drifts)", async () => {
    // The training-transcript bug: coaching "warmer and actually use the librexia stroke slide"
    // drifted the answer to a generic program/indications reply on the program slide. The coaching
    // now feeds the trial-specificity signal, so it holds the stroke slide (and can't drift topic).
    const c = await createContainer();
    const out = await c.orchestrator.handleTurn(ctxFor(c, "what is the LIBREXIA stroke trial"), {
      preview: true,
      coaching: ["be warmer", "actually use the LIBREXIA stroke slide to answer"],
    });
    expect(out.route).toBe("approved_answer");
    expect(out.detailAidSlideId).toBe("slide_stroke");
    expect(out.responseText.toLowerCase()).toMatch(/stroke/);
  }, 60_000);
});
