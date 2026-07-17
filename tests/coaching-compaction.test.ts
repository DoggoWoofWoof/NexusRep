/**
 * A coached "style" thread compacts to ONE small rule — no embedded example answer, capped length.
 * Regression guard for the "rules were so big" fix: baking the accepted answer (hundreds of chars)
 * into every rule bloated the Rules list and rotted the rep's system prompt as rules accumulated.
 */

import { describe, expect, it } from "vitest";
import { compactCoaching } from "@modules/content";

describe("compactCoaching keeps a coached rule small (no context rot)", () => {
  it("returns one short capped directive with the answer prose NOT baked in", async () => {
    const answer =
      "Milvexian is an investigational oral Factor XIa inhibitor being studied as an anticoagulant across the LIBREXIA program. ".repeat(4);
    const { instruction } = await compactCoaching(
      ["be warmer and less clinical", "lead with the mechanism"],
      { question: "How does Milvexian work?", answer },
    );
    expect(instruction.trim().length).toBeGreaterThan(0);
    expect(instruction.length).toBeLessThanOrEqual(180); // capped — can't balloon
    expect(instruction.toLowerCase()).not.toContain("for example"); // no embedded example clause
    expect(instruction).not.toContain(answer.slice(0, 80)); // the accepted answer is NOT inlined
  });
});
