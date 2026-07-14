import { describe, expect, it } from "vitest";
import { asId, type ApprovedAnswerId } from "@lib/ids";
import { ContentService, buildApprovedResponse, type ApprovedAnswer, type MlrMetadata } from "@modules/content";
import { isErr, isOk } from "@lib/result";

function mlr(over: Partial<MlrMetadata> = {}): MlrMetadata {
  return {
    mlrApprovalId: asId("mlr_1"),
    status: "active",
    version: 1,
    audience: "cardiologist",
    indication: "ACS",
    market: "US",
    expiresAt: "2027-01-01",
    sourceFile: "x.pptx",
    ...over,
  };
}

function answer(id: string, over: Partial<MlrMetadata> = {}): ApprovedAnswer {
  return {
    id: asId<"approved_answer_id">(id) as ApprovedAnswerId,
    tenantId: asId("t"),
    brandId: asId("b"),
    campaignId: asId("c"),
    contentAssetId: asId("ca"),
    topic: "dosing",
    text: "Approved dosing text.",
    mlr: mlr(over),
  };
}

describe("source validation", () => {
  it("validates active, in-audience, unexpired content", async () => {
    const svc = new ContentService();
    await svc.addAnswer(answer("ans_ok"));
    const r = await svc.validateAnswer(asId("ans_ok"), { audience: "cardiologist", indication: "ACS", market: "US" });
    expect(isOk(r)).toBe(true);
  });

  it("rejects non-active content", async () => {
    const svc = new ContentService();
    await svc.addAnswer(answer("ans_draft", { status: "draft" }));
    const r = await svc.validateAnswer(asId("ans_draft"));
    expect(isErr(r) && r.error).toBe("not_active");
  });

  it("rejects expired content", async () => {
    const svc = new ContentService();
    await svc.addAnswer(answer("ans_old", { expiresAt: "2000-01-01" }));
    const r = await svc.validateAnswer(asId("ans_old"));
    expect(isErr(r) && r.error).toBe("expired");
  });

  it("rejects audience mismatch", async () => {
    const svc = new ContentService();
    await svc.addAnswer(answer("ans_aud"));
    const r = await svc.validateAnswer(asId("ans_aud"), { audience: "oncologist" });
    expect(isErr(r) && r.error).toBe("audience_mismatch");
  });

  it("rejects unknown ids", async () => {
    const svc = new ContentService();
    const r = await svc.validateAnswer(asId("missing"));
    expect(isErr(r) && r.error).toBe("not_found");
  });
});

describe("buildApprovedResponse — slide-cue toggle (first-answer trim)", () => {
  it("includes the spoken slide cue by default", () => {
    const r = buildApprovedResponse([answer("a1")], { includeIsi: false, slideTitle: "Mechanism of action", seed: "s" });
    expect(r?.text).toMatch(/slide/i);
    expect(r?.text).toContain("Approved dosing text.");
  });

  it("omits the slide cue when slideCue is false (the ISI turn) but keeps the answer body", () => {
    const r = buildApprovedResponse([answer("a1")], { includeIsi: false, slideTitle: "Mechanism of action", seed: "s", slideCue: false });
    expect(r?.text).not.toMatch(/slide/i);
    expect(r?.text).toContain("Approved dosing text.");
  });
});
