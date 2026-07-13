/**
 * Agentic intent: a doctor asking to SEE / show / walk through the rep's own slides/deck is a
 * request to present APPROVED content — it must route to an answer, not the "let me connect you
 * with a person" safe-bounce. Only an explicit ask for a human routes to a handoff. (Keyword
 * classifier; the LLM classifier's prompt carries the same guidance.)
 */

import { describe, expect, it } from "vitest";
import { classify, route } from "@modules/compliance";
import { createContainer } from "@lib/container";

const routeOf = (text: string) => route(classify(text));

describe("presentation / slide requests are answered, not bounced", () => {
  for (const q of [
    "Can you show your slides to me?",
    "What do you have in your slides?",
    "Walk me through the deck",
    "show me the presentation",
    "what can you show me",
  ]) {
    it(`"${q}" → approved_answer`, () => {
      expect(routeOf(q)).toBe("approved_answer");
    });
  }

  it("an explicit human request still routes to a person", () => {
    expect(routeOf("I want to talk to a human rep")).toBe("human_handoff");
    expect(routeOf("can a representative call me")).toBe("human_handoff");
  });

  it("a genuine adverse-event report still outranks everything", () => {
    expect(routeOf("my patient developed bleeding after the dose")).toBe("adverse_event");
  });
});

describe("context-aware presentation follow-up", () => {
  const ask = (c: Awaited<ReturnType<typeof createContainer>>, sessionId: string, text: string) =>
    c.conversation
      .turn({ sessionId: sessionId as never, hcpId: c.demo.hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text })
      .then((r) => r.output);

  it("'show me the slides' after a mechanism question surfaces the mechanism slide", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const moa = await ask(c, s.id, "How does Milvexian work?");
    expect(moa.detailAidSlideId).toBe("slide_moa");
    const followup = await ask(c, s.id, "show me the slides");
    expect(followup.route).toBe("approved_answer"); // answered, not a handoff/fallback
    expect(followup.detailAidSlideId).toBe("slide_moa"); // biased to the topic just discussed
  });

  it("a bare 'show me the slides' with no prior context still answers (not a bounce)", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const out = await ask(c, s.id, "show me the slides");
    expect(out.route).toBe("approved_answer");
  });
});
