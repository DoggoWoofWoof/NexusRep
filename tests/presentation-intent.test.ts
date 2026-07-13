/**
 * Agentic intent: a doctor asking to SEE / show / walk through the rep's own slides/deck is a
 * request to present APPROVED content — it must route to an answer, not the "let me connect you
 * with a person" safe-bounce. Only an explicit ask for a human routes to a handoff. (Keyword
 * classifier; the LLM classifier's prompt carries the same guidance.)
 */

import { describe, expect, it } from "vitest";
import { classify, route } from "@modules/compliance";

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
