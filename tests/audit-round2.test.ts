/**
 * Regression tests for the full-audit fix round: ISI dedup whitespace parity,
 * self-healing cohort replacement, and CRM event payload shape.
 */
import { describe, expect, it } from "vitest";
import { asId, type SessionId } from "@lib/ids";
import { isiAlreadyDelivered } from "@modules/compliance";
import { TargetingService, MILVEXIAN_COHORT, type HCPFeatures } from "@modules/audience";
import { CrmOutbox } from "@modules/crm";
import { MockCrmAdapter } from "@modules/vendors/mock";

describe("ISI delivery detection (the ONE shared implementation)", () => {
  const isi = "Milvexian is investigational.  Safety and efficacy   have not been established.";
  const event = (text: string) => ({ type: "response_output", payload: { text } });

  it("detects prior delivery despite whitespace variance (the orchestrator now shares this)", () => {
    // The audit found the orchestrator kept a private un-normalized copy of this check —
    // reflowed whitespace in the audit trail would have re-delivered ISI.
    const reflowed = `Answer text.\n\nImportant Safety Information: Milvexian is investigational. Safety and efficacy have not been established.`;
    expect(isiAlreadyDelivered([event(reflowed)], isi)).toBe(true);
  });

  it("does not false-positive on partial/absent ISI", () => {
    expect(isiAlreadyDelivered([event("Answer without safety block.")], isi)).toBe(false);
    expect(isiAlreadyDelivered([], isi)).toBe(false);
  });
});

describe("TargetingService.replaceCohort (live cohort recovery)", () => {
  const prelaunch = (id: string, patients: number): HCPFeatures => ({
    id: asId<"hcp_id">(id),
    name: `Dr. ${id}`,
    specialty: "Cardiology",
    decile: 1,
    eligiblePatients: patients,
    brandSharePct: 0,
    trendPct: 0,
    seesReps: true,
    repTouchesQtr: 0,
  });

  it("swaps the cohort in place and recomputes weights + density reference", () => {
    const t = new TargetingService(MILVEXIAN_COHORT); // modeled boot fallback
    const before = t.rank()[0]!.name;
    t.replaceCohort([prelaunch("hcp_live_a", 40), prelaunch("hcp_live_b", 10)]);
    const ranked = t.rank();
    expect(ranked.map((r) => r.name)).toEqual(["Dr. hcp_live_a", "Dr. hcp_live_b"]);
    expect(ranked[0]!.name).not.toBe(before);
    // pre-launch uniform signals renormalize away after the swap too
    expect(ranked[0]!.score).toBe(100);
    expect(ranked[0]!.components.find((c) => c.key === "whitespace")!.weight).toBe(0);
    // identity checks resolve against the NEW cohort (prefix-tolerant)
    expect(t.get("live_a")?.name).toBe("Dr. hcp_live_a");
    expect(t.has(String(MILVEXIAN_COHORT[0]!.id))).toBe(false);
  });
});

describe("CRM event payload shape (what the outbox hands the adapter)", () => {
  it("carries every field identity resolution and delivery need", async () => {
    const outbox = new CrmOutbox(new MockCrmAdapter());
    const entry = await outbox.enqueue(asId<"session_id">("session_shape") as SessionId, {
      eventType: "followup_msl",
      brandId: "brand_x",
      campaignId: "camp_y",
      sessionId: "session_shape",
      followUpType: "msl",
      hcpNpi: "1234567890",
    });
    expect(entry.payload).toMatchObject({
      eventType: "followup_msl",
      brandId: "brand_x",
      campaignId: "camp_y",
      sessionId: "session_shape",
      hcpNpi: "1234567890",
    });
    const delivered = await outbox.deliver(entry.id);
    expect(delivered?.status).toBe("sent");
    expect(delivered?.attempts).toBe(1);
  });

  it("reports needs_mapping truthfully when no NPI is resolvable", async () => {
    const outbox = new CrmOutbox(new MockCrmAdapter());
    const entry = await outbox.enqueue(asId<"session_id">("session_nonpi") as SessionId, {
      eventType: "followup_pharmacovigilance",
      brandId: "b",
      campaignId: "c",
      sessionId: "session_nonpi",
    });
    const delivered = await outbox.deliver(entry.id);
    expect(delivered?.status).toBe("needs_mapping");
  });
});
