/**
 * gatePresentationSegment — the per-segment ISI + compliance-gate core shared by the live overview
 * route and the training-preview route (previously duplicated inline in both). Locks in the
 * safety-critical behavior: ISI is appended verbatim on the last segment when not yet delivered,
 * never re-appended, recognized when already inline, and an ungrounded segment is blocked.
 */

import { describe, expect, it } from "vitest";
import { gatePresentationSegment, type RiskClassification } from "@modules/compliance";

const BASE: RiskClassification = {
  intent: "product_info",
  confidence: 0.95,
  offLabelRisk: 0,
  adverseEventRisk: 0,
  medicalInfoRisk: 0,
  promptInjectionRisk: 0,
  comparativeClaimRisk: 0,
  isiRequired: false,
};
const ISI = "Do not use with active bleeding.";
const seg = (over: Partial<Parameters<typeof gatePresentationSegment>[0]>) =>
  gatePresentationSegment({
    text: "Milvexian is an investigational Factor XIa inhibitor.",
    sourceIds: ["ans_moa"],
    isiText: ISI,
    isiAlreadyDelivered: false,
    isLastSegment: false,
    route: "approved_answer",
    baseClassification: BASE,
    safeFallback: "SAFE FALLBACK",
    ...over,
  });

describe("gatePresentationSegment", () => {
  it("no ISI configured → no requirement, text passes through", () => {
    const r = seg({ isiText: undefined, isLastSegment: true });
    expect(r.approved).toBe(true);
    expect(r.shouldRequireSafety).toBe(false);
    expect(r.finalText).not.toContain("Important Safety Information");
  });

  it("last segment, ISI not yet delivered → appends the verbatim ISI and approves", () => {
    const r = seg({ isLastSegment: true });
    expect(r.shouldAppendSafety).toBe(true);
    expect(r.shouldRequireSafety).toBe(true);
    expect(r.approved).toBe(true);
    expect(r.finalText).toContain(`Important Safety Information: ${ISI}`);
  });

  it("NON-last segment → does not require/append ISI", () => {
    const r = seg({ isLastSegment: false });
    expect(r.shouldRequireSafety).toBe(false);
    expect(r.shouldAppendSafety).toBe(false);
    expect(r.finalText).not.toContain("Important Safety Information");
  });

  it("ISI already delivered → never re-appends on the last segment", () => {
    const r = seg({ isLastSegment: true, isiAlreadyDelivered: true });
    expect(r.shouldAppendSafety).toBe(false);
    expect(r.shouldRequireSafety).toBe(false);
  });

  it("segment already contains the ISI inline → recognized, required, not double-appended", () => {
    const r = seg({ text: `Some approved text.\n\nImportant Safety Information: ${ISI}`, isLastSegment: true });
    expect(r.includesSafetyText).toBe(true);
    expect(r.shouldRequireSafety).toBe(true);
    expect(r.shouldAppendSafety).toBe(false);
    // exactly one ISI occurrence (not doubled)
    expect(r.finalText.match(/Important Safety Information/g)?.length).toBe(1);
  });

  it("ungrounded segment on an approved-answer route is BLOCKED → safe fallback", () => {
    const r = seg({ sourceIds: [], isLastSegment: false });
    expect(r.approved).toBe(false);
    expect(r.finalText).toBe("SAFE FALLBACK");
    expect(r.decision.reasons).toContain("ungrounded_response");
  });
});
