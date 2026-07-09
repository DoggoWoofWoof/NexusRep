import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";
import { asId } from "@lib/ids";
import type { ApprovedAnswer, SafetyStatement } from "@modules/content";

/** An uploaded/parsed answer lands as in_mlr (not retrievable) until approved. */
function uploaded(c: Awaited<ReturnType<typeof createContainer>>): ApprovedAnswer {
  return {
    id: asId<"approved_answer_id">("upload_test_1"),
    tenantId: c.demo.tenantId,
    brandId: c.demo.brandId,
    campaignId: c.demo.campaignId,
    contentAssetId: asId<"content_asset_id">("asset_upload_test"),
    topic: "uploaded",
    text: "Reviewed public statement mentioning zzquniquetoken about the Milvexian program.",
    mlr: {
      mlrApprovalId: asId<"mlr_approval_id">("mlr_upload_test"),
      status: "in_mlr",
      version: 1,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      expiresAt: null,
      sourceFile: "uploaded_deck.pptx",
    },
  };
}

function revisedIsi(c: Awaited<ReturnType<typeof createContainer>>): SafetyStatement {
  return {
    id: asId<"safety_statement_id">("isi_revised_test"),
    tenantId: c.demo.tenantId,
    brandId: c.demo.brandId,
    campaignId: c.demo.campaignId,
    text: "Revised approved ISI: investigational compound; safety and efficacy have not been established; contact Medical Information for clinical questions.",
    mlr: {
      mlrApprovalId: asId<"mlr_approval_id">("mlr_isi_revised_test"),
      status: "in_mlr",
      version: 2,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      expiresAt: null,
      sourceFile: "studio_isi_editor",
    },
  };
}

describe("MLR review workflow (ingest → in_mlr → approve → live)", () => {
  it("keeps ingested content out of retrieval until approved, then publishes it", async () => {
    const c = await createContainer();
    await c.content.addAnswer(uploaded(c));
    const ctx = { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market };
    const query = { text: "zzquniquetoken", context: ctx };

    // Appears in the MLR review queue.
    expect((await c.mlr.listPending()).some((a) => a.id === "upload_test_1")).toBe(true);

    // Not retrievable while in_mlr (never indexed, and status isn't active).
    const before = await c.retrieval.retrieveApproved(query);
    expect(before.answers.some((a) => a.id === "upload_test_1")).toBe(false);

    // Approve → active + published to retrieval.
    const approved = await c.mlr.approve(asId<"approved_answer_id">("upload_test_1"));
    expect(approved?.mlr.status).toBe("active");

    const after = await c.retrieval.retrieveApproved(query);
    expect(after.answers.some((a) => a.id === "upload_test_1")).toBe(true);

    // No longer pending.
    expect((await c.mlr.listPending()).some((a) => a.id === "upload_test_1")).toBe(false);
  });

  it("rejecting retires the content (stays out of retrieval)", async () => {
    const c = await createContainer();
    await c.content.addAnswer(uploaded(c));
    const rejected = await c.mlr.reject(asId<"approved_answer_id">("upload_test_1"));
    expect(rejected?.mlr.status).toBe("retired");
    expect((await c.mlr.listPending()).some((a) => a.id === "upload_test_1")).toBe(false);
  });

  it("approves a revised ISI block and retires the previous active ISI", async () => {
    const c = await createContainer();
    await c.content.addSafetyStatement(revisedIsi(c));

    expect((await c.mlr.listPendingSafety()).some((s) => s.id === "isi_revised_test")).toBe(true);

    const approved = await c.mlr.approveSafety(asId<"safety_statement_id">("isi_revised_test"));
    expect(approved?.mlr.status).toBe("active");

    const latest = await c.content.latestActiveSafetyStatement();
    expect(latest?.id).toBe("isi_revised_test");
    expect((await c.content.getSafetyStatement(asId<"safety_statement_id">("isi_main")))?.mlr.status).toBe("retired");
    expect((await c.mlr.listPendingSafety()).some((s) => s.id === "isi_revised_test")).toBe(false);
  });
});
