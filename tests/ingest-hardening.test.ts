/**
 * Stress tests for "what does it do with incomplete / adversarial input" — focused on the one
 * real gap the audit found: the grounding validator's blindness to a flipped negation. Token-set
 * coverage treats "not FDA approved" and "FDA approved" as identical (all words match, "not" is a
 * stop word), so a dropped negation used to pass as grounded. The polarity guard closes that.
 *
 * The safe consequence of a grounding failure is a fallback to the VERBATIM approved text, so
 * these assert the flip is caught while faithful rephrasings still pass (no false positives).
 */

import { describe, expect, it } from "vitest";
import { validateGrounding } from "@modules/compliance/grounding";

// A real seeded Milvexian mechanism block (investigational, explicitly NOT approved).
const MOA =
  "It is an investigational, orally administered Factor XIa (FXIa) inhibitor being studied as an anticoagulant. It is not approved by the FDA or any regulatory authority.";

describe("grounding: claim-polarity guard (dropped/flipped negation)", () => {
  it("catches an investigational drug asserted as APPROVED (coverage still high — only polarity fails)", () => {
    const r = validateGrounding({
      answer: "It is an investigational oral Factor XIa inhibitor being studied as an anticoagulant. It is approved by the FDA.",
      blocks: [MOA],
    });
    expect(r.coverage).toBeGreaterThanOrEqual(0.5); // the words all match — token coverage passes
    expect(r.polarityDrift).toContain("approved"); // …but the positive "approved" is a flip
    expect(r.grounded).toBe(false);
  });

  it("a faithful rephrase that KEEPS the negation stays grounded (no false positive)", () => {
    const r = validateGrounding({
      answer: "It is an investigational Factor XIa inhibitor being studied as an anticoagulant, and is not approved by the FDA.",
      blocks: [MOA],
    });
    expect(r.polarityDrift).toEqual([]);
    expect(r.grounded).toBe(true);
  });

  it("catches invented efficacy / superiority claims", () => {
    const r = validateGrounding({
      answer: "Milvexian is safe and effective, and superior to apixaban.",
      blocks: [MOA],
    });
    expect(r.grounded).toBe(false);
    expect(r.polarityDrift.length).toBeGreaterThan(0);
  });

  it("still catches fabricated numbers (regression)", () => {
    const r = validateGrounding({
      answer: "It reduces stroke risk by 47% across 12000 patients.",
      blocks: [MOA],
    });
    expect(r.grounded).toBe(false);
    expect(r.ungroundedNumbers.length).toBeGreaterThan(0);
  });

  it("the verbatim approved block is always grounded (deterministic builder path)", () => {
    const r = validateGrounding({ answer: MOA, blocks: [MOA] });
    expect(r.grounded).toBe(true);
    expect(r.polarityDrift).toEqual([]);
  });

  it("a positively-stated claim that the block ALSO states positively is fine", () => {
    const blocks = ["Milvexian is being evaluated across three indications and is well studied."];
    const r = validateGrounding({ answer: "Milvexian is being studied across three indications.", blocks });
    expect(r.polarityDrift).toEqual([]);
    expect(r.grounded).toBe(true);
  });
});
