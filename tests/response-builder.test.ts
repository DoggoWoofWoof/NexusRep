import { describe, expect, it } from "vitest";
import { asId, type ApprovedAnswerId, type DetailAidSlideId, type SafetyStatementId } from "@lib/ids";
import { buildApprovedResponse, slideReference, weaveSlideCueEarly, type ApprovedAnswer, type SafetyStatement } from "@modules/content";

const answer = (id: string, text: string, slideId?: string): ApprovedAnswer => ({
  id: asId<"approved_answer_id">(id) as ApprovedAnswerId,
  tenantId: asId("t"), brandId: asId("b"), campaignId: asId("c"), contentAssetId: asId("ca"),
  topic: "dosing", text,
  detailAidSlideId: slideId ? (asId<"detail_aid_slide_id">(slideId) as DetailAidSlideId) : undefined,
  mlr: { mlrApprovalId: asId("m"), status: "active", version: 1, audience: "cardiologist", indication: "ACS", market: "US", expiresAt: null, sourceFile: "f" },
});

const isi: SafetyStatement = {
  id: asId<"safety_statement_id">("isi") as SafetyStatementId,
  tenantId: asId("t"), brandId: asId("b"), campaignId: asId("c"),
  text: "Do not use with active bleeding.",
  mlr: { mlrApprovalId: asId("m"), status: "active", version: 1, audience: "cardiologist", indication: "ACS", market: "US", expiresAt: null, sourceFile: "f" },
};

describe("response builder (approved blocks only)", () => {
  it("composes from the approved block and surfaces the detail-aid slide", () => {
    const r = buildApprovedResponse([answer("a1", "Take one daily.", "slide_1")], { includeIsi: false });
    expect(r).not.toBeNull();
    expect(r!.text).toContain("Take one daily.");
    expect(r!.sourceIds).toEqual(["a1"]);
    expect(r!.detailAidSlideId).toBe("slide_1");
    expect(r!.isiAppended).toBe(false);
  });

  it("appends verbatim ISI when required", () => {
    const r = buildApprovedResponse([answer("a1", "Take one daily.", "slide_1")], { isi, includeIsi: true });
    expect(r!.isiAppended).toBe(true);
    expect(r!.text).toContain("Important Safety Information: Do not use with active bleeding.");
  });

  it("returns null when there is no approved block (caller fails safe)", () => {
    expect(buildApprovedResponse([], { includeIsi: false })).toBeNull();
  });

  it("weaves the claim-free slide reference EARLY — before the medical body, so the deck switches up front", () => {
    const r = buildApprovedResponse([answer("a1", "Take one daily.", "slide_1")], { includeIsi: false, slideTitle: "Mechanism of action" })!;
    // The "look at the … slide" reference now leads the medical body (the fix for "the slide only
    // moved at the very end"): the rep puts the slide up, then talks to it.
    expect(r.text).toContain("Take one daily.");
    expect(r.text.toLowerCase()).toContain("mechanism of action slide");
    expect(r.text.toLowerCase().indexOf("mechanism of action slide")).toBeLessThan(r.text.indexOf("Take one daily."));
  });

  it("points at a SECOND relevant slide when one is retrieved (uses more of the deck)", () => {
    const r = buildApprovedResponse(
      [answer("a1", "Take one daily.", "slide_1"), answer("a2", "It is investigational.", "slide_2")],
      { includeIsi: false, slideTitle: "Mechanism of action", relatedTitle: "Development status" },
    )!;
    expect(r.text.toLowerCase()).toContain("mechanism of action slide");
    expect(r.text.toLowerCase()).toContain("development status slide");
  });

  it("keeps ISI last — after the woven slide reference", () => {
    const r = buildApprovedResponse([answer("a1", "Take one daily.", "slide_1")], { isi, includeIsi: true, slideTitle: "Mechanism of action" })!;
    expect(r.text.toLowerCase().indexOf("mechanism of action slide")).toBeLessThan(r.text.indexOf("Important Safety Information"));
  });

  it("weaveSlideCueEarly puts the cue after the opener (before the body), or leads when body is one sentence", () => {
    expect(weaveSlideCueEarly("Good question. Milvexian is investigational.", "I've pulled up the mechanism slide."))
      .toBe("Good question. I've pulled up the mechanism slide. Milvexian is investigational.");
    // Single-sentence body → nothing to sit behind → lead with the cue.
    expect(weaveSlideCueEarly("Milvexian is investigational", "I've pulled up the mechanism slide."))
      .toBe("I've pulled up the mechanism slide. Milvexian is investigational");
    // No cue → unchanged.
    expect(weaveSlideCueEarly("Good question. Body.", "")).toBe("Good question. Body.");
  });

  it("slideReference is empty for routed/refusal turns (no slide) and injects no numbers/claims", () => {
    expect(slideReference({ seed: "x" })).toBe("");
    const ref = slideReference({ seed: "x", slideTitle: "Mechanism of action" });
    expect(ref).not.toMatch(/\d/); // claim-free: never introduces a dose/number
    expect(ref.toLowerCase()).toContain("slide");
  });
});
