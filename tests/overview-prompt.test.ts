import { describe, expect, it } from "vitest";
import { isOverviewPrompt } from "../src/app/_app/overviewPrompt";

describe("HCP overview prompt detector", () => {
  it("starts the rep-led deck overview from natural broad questions", () => {
    expect(isOverviewPrompt("Can you give me a quick overview of Milvexian?")).toBe(true);
    expect(isOverviewPrompt("What should I know about the LIBREXIA program?")).toBe(true);
    expect(isOverviewPrompt("Can you walk me through the deck?")).toBe(true);
  });

  it("does not steal human-representative requests", () => {
    expect(isOverviewPrompt("Can a human representative call me after this session?")).toBe(false);
    expect(isOverviewPrompt("I need to speak to someone.")).toBe(false);
  });
});
