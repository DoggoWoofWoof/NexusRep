import { describe, expect, it } from "vitest";
import { asId } from "@lib/ids";
import { SessionService, deriveSessionDurationSeconds, outcomeToStatus } from "@modules/sessions";
import { ConversationService, type TurnOrchestrator, type TurnOutput } from "@modules/realtime";
import { AuditService } from "@modules/audit";
import { CrmOutbox } from "@modules/crm";
import { getCrmAdapter } from "@modules/vendors";

const aiRepId = asId<"ai_rep_id">("airep_test");
const hcpId = asId<"hcp_id">("hcp_test");
const brandId = asId<"brand_id">("brand_test");
const campaignId = asId<"campaign_id">("camp_test");

function fakeOrchestrator(out: TurnOutput): TurnOrchestrator {
  return { handleTurn: async () => out } as unknown as TurnOrchestrator;
}

function output(partial: Partial<TurnOutput>): TurnOutput {
  return {
    route: "approved_answer",
    responseText: "ok",
    sourceIds: ["ans_dosing"],
    isiAttached: false,
    decision: "approved",
    reasons: [],
    ...partial,
  };
}

describe("SessionService", () => {
  it("counts only HCP turns as questions and keeps rep turns", async () => {
    const svc = new SessionService();
    const s = await svc.start({ aiRepId, hcpId, seed: "s1", startedAt: "2026-07-08T09:00:00.000Z" });
    await svc.appendTurn(s.id, { speaker: "hcp", text: "dose?", seed: "t1" });
    await svc.appendTurn(s.id, { speaker: "rep", text: "one tablet", sourceIds: ["ans_dosing"], seed: "t2" });
    const after = await svc.get(s.id);
    expect(after?.turns).toHaveLength(2);
    expect(after?.questionCount).toBe(1);
  });

  it("folds the worst per-turn outcome into the session status", async () => {
    const svc = new SessionService();
    const s = await svc.start({ aiRepId, hcpId, seed: "s2" });
    await svc.recordOutcome(s.id, { route: "approved_answer", decision: "approved" });
    expect((await svc.get(s.id))?.complianceStatus).toBe("approved");
    await svc.recordOutcome(s.id, { route: "adverse_event", decision: "approved" });
    expect((await svc.get(s.id))?.complianceStatus).toBe("ae_routed");
    // A later benign turn never downgrades the recorded severity.
    await svc.recordOutcome(s.id, { route: "approved_answer", decision: "approved" });
    expect((await svc.get(s.id))?.complianceStatus).toBe("ae_routed");
    await svc.recordOutcome(s.id, { route: "approved_answer", decision: "blocked" });
    expect((await svc.get(s.id))?.complianceStatus).toBe("blocked_escalated");
  });

  it("derives duration from endedAt", async () => {
    const svc = new SessionService();
    const s = await svc.start({ aiRepId, hcpId, seed: "s3", startedAt: "2026-07-08T09:00:00.000Z" });
    const ended = await svc.end(s.id, { endedAt: "2026-07-08T09:07:48.000Z" });
    expect(ended?.durationSeconds).toBe(7 * 60 + 48);
  });

  it("derives review duration from transcript span when a live call was not explicitly ended", async () => {
    const svc = new SessionService();
    const s = await svc.start({ aiRepId, hcpId, seed: "s4", startedAt: "2026-07-08T09:00:00.000Z" });
    await svc.appendTurn(s.id, { speaker: "rep", text: "hello", at: "2026-07-08T09:00:12.000Z" });
    await svc.appendTurn(s.id, { speaker: "hcp", text: "question", at: "2026-07-08T09:01:30.000Z" });
    await svc.appendTurn(s.id, { speaker: "rep", text: "answer", at: "2026-07-08T09:02:42.000Z" });
    const after = await svc.get(s.id);
    expect(after?.durationSeconds).toBe(0);
    expect(after ? deriveSessionDurationSeconds(after) : 0).toBe(150);
  });

  it("maps routes to statuses", () => {
    expect(outcomeToStatus({ route: "approved_answer", decision: "approved" })).toBe("approved");
    expect(outcomeToStatus({ route: "off_label_refusal", decision: "approved" })).toBe("needs_review");
    expect(outcomeToStatus({ route: "adverse_event", decision: "approved" })).toBe("ae_routed");
    expect(outcomeToStatus({ route: "approved_answer", decision: "blocked" })).toBe("blocked_escalated");
  });
});

describe("ConversationService", () => {
  function build(out: TurnOutput) {
    const sessions = new SessionService();
    const audit = new AuditService();
    const crm = new CrmOutbox(getCrmAdapter());
    const conversation = new ConversationService({
      orchestrator: fakeOrchestrator(out),
      sessions,
      crm,
      audit,
      context: { brandId, campaignId },
    });
    return { sessions, audit, crm, conversation };
  }

  it("logs both sides of a turn and folds compliance status", async () => {
    const { sessions, conversation } = build(output({ route: "approved_answer", decision: "approved" }));
    const s = await conversation.start({ aiRepId, hcpId, seed: "c1" });
    const { session } = await conversation.turn({ sessionId: s.id, hcpId, text: "What is the dose?" });
    expect(session?.turns.map((t) => t.speaker)).toEqual(["hcp", "rep"]);
    expect(session?.questionCount).toBe(1);
    expect(session?.complianceStatus).toBe("approved");
    expect((await sessions.get(s.id))?.turns[1]?.sourceIds).toEqual(["ans_dosing"]);
  });

  it("enqueues a CRM outbox event and audits it on escalation", async () => {
    const { crm, audit, conversation } = build(
      output({ route: "adverse_event", responseText: "logged", sourceIds: [], followUpType: "pharmacovigilance" }),
    );
    const s = await conversation.start({ aiRepId, hcpId, seed: "c2" });
    const { session } = await conversation.turn({ sessionId: s.id, hcpId, text: "I had a bad reaction" });
    expect(session?.complianceStatus).toBe("ae_routed");
    const outbox = await crm.list();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload.eventType).toBe("followup_pharmacovigilance");
    const events = await audit.forSession(s.id);
    expect(events.some((e) => e.type === "crm_event")).toBe(true);
  });
});
