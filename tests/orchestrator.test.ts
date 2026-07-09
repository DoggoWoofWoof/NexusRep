import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";
import { asId } from "@lib/ids";
import type { SafetyStatement } from "@modules/content";

function revisedIsi(c: Awaited<ReturnType<typeof createContainer>>): SafetyStatement {
  return {
    id: asId<"safety_statement_id">("isi_runtime_revised"),
    tenantId: c.demo.tenantId,
    brandId: c.demo.brandId,
    campaignId: c.demo.campaignId,
    text: "Runtime approved revised ISI. Safety and efficacy have not been established. Contact Medical Information for clinical questions.",
    mlr: {
      mlrApprovalId: asId<"mlr_approval_id">("mlr_runtime_revised"),
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

describe("turn orchestrator (controlled agent graph)", () => {
  it("answers a public product-info question from approved content with the required disclosure", async () => {
    const c = await createContainer();
    const out = await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text: "What is Milvexian and how does it work?",
    });
    expect(out.route).toBe("approved_answer");
    expect(out.decision).toBe("approved");
    expect(out.sourceIds.length).toBeGreaterThan(0);
    expect(out.isiAttached).toBe(true);
    expect(out.responseText).toContain("Important Safety Information");
    // Detail-aid tool call: a source-driven public-info slide is surfaced.
    expect(["slide_moa", "slide_program", "slide_status"]).toContain(out.detailAidSlideId);
  });

  it("routes a clinical-specifics question about the investigational drug to Medical Information", async () => {
    const c = await createContainer();
    const out = await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text: "What is the recommended dose and titration?",
    });
    // Investigational guardrail: never answered directly — sent to MSL, and the
    // routing message is actually spoken (not blocked as isi_missing).
    expect(out.route).toBe("medical_information");
    expect(out.followUpType).toBe("medical_information");
    expect(out.sourceIds).toEqual([]);
    expect(out.decision).toBe("approved");
    expect(out.responseText.toLowerCase()).toContain("medical information");
  });

  it("uses the newly approved ISI block exactly after an ISI revision is approved", async () => {
    const c = await createContainer();
    await c.content.addSafetyStatement(revisedIsi(c));
    await c.mlr.approveSafety(asId<"safety_statement_id">("isi_runtime_revised"));

    const out = await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text: "What is Milvexian and how does it work?",
    });

    expect(out.decision).toBe("approved");
    expect(out.responseText).toContain("Important Safety Information: Runtime approved revised ISI.");
    expect(out.responseText).not.toContain("Milvexian is an investigational compound not approved by the FDA or any regulatory authority; its safety and efficacy have not been established.");
  });

  it("refuses an off-label question and creates an MSL follow-up", async () => {
    const c = await createContainer();
    const out = await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId,
      hcpId: c.demo.hcpId,
      text: "Can I use this off-label for pediatric patients?",
    });
    expect(out.route).toBe("off_label_refusal");
    expect(out.followUpType).toBe("msl");
    const followups = await c.followups.list();
    expect(followups.some((f) => f.type === "msl")).toBe(true);
  });

  it("routes an adverse-event mention to pharmacovigilance", async () => {
    const c = await createContainer();
    const out = await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId,
      hcpId: c.demo.hcpId,
      text: "My patient had a severe rash and swelling after taking it",
    });
    expect(out.route).toBe("adverse_event");
    expect(out.followUpType).toBe("pharmacovigilance");
  });

  it("writes an audit record for every turn", async () => {
    const c = await createContainer();
    await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId,
      hcpId: c.demo.hcpId,
      text: "Tell me about the safety information",
    });
    const audit = await c.audit.forSession(c.demo.sessionId);
    const types = audit.map((a) => a.type);
    expect(types).toContain("classification");
    expect(types).toContain("compliance_decision");
    expect(types).toContain("response_output");
  });
});
