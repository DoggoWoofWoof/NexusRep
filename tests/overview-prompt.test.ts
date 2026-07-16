import { describe, expect, it } from "vitest";
import { isOverviewPrompt } from "../src/app/_app/overviewPrompt";

describe("HCP overview prompt detector", () => {
  it("starts the rep-led deck overview from natural broad questions", () => {
    expect(isOverviewPrompt("Can you give me a quick overview of Milvexian?")).toBe(true);
    expect(isOverviewPrompt("Can you walk me through the deck?")).toBe(true);
    expect(isOverviewPrompt("Can you walk me through the approved information?")).toBe(true);
  });

  it("does not turn specific topic questions into full deck walkthroughs", () => {
    expect(isOverviewPrompt("What should I know about the LIBREXIA program?")).toBe(false);
    expect(isOverviewPrompt("Can you say a little more about mechanism of action?")).toBe(false);
  });

  it("treats a 'what does the approved information cover on X' question as SPECIFIC, not an overview", () => {
    // The auto-generated try-chips are phrased this way; the words "approved information" must NOT
    // swallow the specific question into the whole-deck walkthrough.
    expect(isOverviewPrompt("What does the approved information cover on sponsor and collaboration?")).toBe(false);
    expect(isOverviewPrompt("What does the approved information cover on drug class?")).toBe(false);
    expect(isOverviewPrompt("Does the approved information mention dosing?")).toBe(false);
    // …but a request to PRESENT the approved information is still an overview.
    expect(isOverviewPrompt("Can you walk me through the approved information?")).toBe(true);
  });

  it("does not steal human-representative requests", () => {
    expect(isOverviewPrompt("Can a human representative call me after this session?")).toBe(false);
    expect(isOverviewPrompt("I need to speak to someone.")).toBe(false);
  });
});
