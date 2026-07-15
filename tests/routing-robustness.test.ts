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

  it("a short affirmation continues the PRIOR topic instead of bouncing", async () => {
    const c = await createContainer();
    await c.conversation.turn(ctxFor(c, "tell me about the LIBREXIA program")); // establishes topic
    const { output } = await c.conversation.turn(ctxFor(c, "yeah sure")); // pure affirmation follow-up
    expect(output.route).toBe("approved_answer");
    expect(output.responseText).not.toMatch(BOUNCE);
    expect(output.responseText.toLowerCase()).toMatch(/librexia|program|stroke|coronary|atrial|milvexian|factor/);
  }, 60_000);

  it("the contact answer does not trap follow-ups in a loop", async () => {
    const c = await createContainer();
    await c.conversation.turn(ctxFor(c, "how does milvexian work")); // real topic
    await c.conversation.turn(ctxFor(c, "how do I reach a person")); // → contact/handoff
    const { output } = await c.conversation.turn(ctxFor(c, "show me the slides")); // follow-up
    // Must bias back to a REAL topic's slide, not re-bounce to the contact answer forever.
    expect(output.responseText.toLowerCase()).not.toMatch(/routed to medical information or an msl/);
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
