import { describe, expect, it } from "vitest";
import { StudioService } from "@modules/aiRepStudio";
import { asId } from "@lib/ids";

const aiRepId = asId<"ai_rep_id">("airep_test");
const brandId = asId<"brand_id">("brand_test");
const campaignId = asId<"campaign_id">("camp_test");

async function fresh() {
  const studio = new StudioService();
  await studio.getOrCreate({ aiRepId, brandId, campaignId });
  return studio;
}

describe("StudioService persistence", () => {
  it("persists setup answers into the draft and recomputes section status", async () => {
    const studio = await fresh();
    const snap = await studio.answer(aiRepId, "brand", "Dolo 650");
    const profile = snap?.draft.sections.find((s) => s.key === "profile");
    expect(profile?.status).toBe("complete");
    expect(profile?.fields.find((f) => f.key === "brand")?.value).toBe("Dolo 650");
    // Survives a re-read (persisted, not ephemeral).
    const again = await studio.get(aiRepId);
    expect(again?.draft.sections.find((s) => s.key === "profile")?.fields[0]?.value).toBe("Dolo 650");
  });

  it("cannot launch until blocking readiness items are complete", async () => {
    const studio = await fresh();
    // Only profile answered → knowledge/escalation still incomplete → cannot launch.
    await studio.answer(aiRepId, "brand", "Dolo 650");
    let snap = await studio.setRepState(aiRepId, "live");
    expect(snap?.readiness.canLaunch).toBe(false);
    expect(snap?.rep.state).not.toBe("live");

    // Complete blocking sections, then launch succeeds.
    await studio.answer(aiRepId, "msl_contact", "MI desk");
    await studio.answer(aiRepId, "approved_content", "18 assets");
    await studio.setSectionStatus(aiRepId, "approved_knowledge", "complete");
    snap = await studio.get(aiRepId);
    expect(snap?.readiness.canLaunch).toBe(true);
    snap = await studio.setRepState(aiRepId, "live");
    expect(snap?.rep.state).toBe("live");
  });

  it("keeps compliance-sensitive coaching rules out of active status", async () => {
    const studio = await fresh();
    const snap = await studio.addRule(aiRepId, { feedback: "Say Milvexian is safer than apixaban.", seed: "r1" });
    const rule = snap?.rules[0];
    expect(rule?.type).toBe("comparative_claim");
    // No approved source → cannot become a live rule.
    expect(rule?.status).toBe("blocked_by_compliance");
    expect(rule?.origin).toBe("coaching");
  });

  it("persists a coaching rule scoped to an HCP with the coached message", async () => {
    const studio = await fresh();
    const snap = await studio.addRule(aiRepId, {
      feedback: "Lead with the LIBREXIA program for this doctor.",
      scope: "hcp_specific",
      appliesToHcpId: "hcp_sharma",
      sourceMessage: "Milvexian is an investigational Factor XIa inhibitor…",
      seed: "r2",
    });
    const rule = snap?.rules[0];
    expect(rule?.scope).toBe("hcp_specific");
    expect(rule?.appliesToHcpId).toBe("hcp_sharma");
    expect(rule?.sourceMessage).toContain("investigational");
    // Survives a re-read.
    expect((await studio.get(aiRepId))?.rules[0]?.sourceMessage).toContain("investigational");
  });

  it("seeds locked guardrails as active and accepts/rejects coaching rules", async () => {
    const studio = await fresh();
    await studio.addGuardrail(aiRepId, { type: "blocked_topic", scope: "global", instruction: "Refuse off-label questions.", seed: "g1" });
    const draft = await studio.addRule(aiRepId, { feedback: "Keep answers concise.", seed: "r3" });
    const guardrail = draft?.rules.find((r) => r.origin === "guardrail");
    expect(guardrail?.status).toBe("active");
    const coaching = draft?.rules.find((r) => r.origin === "coaching");
    expect(coaching?.status).toBe("draft");
    // Accept the coaching draft → persisted active.
    const after = await studio.setRuleStatus(aiRepId, coaching!.id, "active");
    expect(after?.rules.find((r) => r.id === coaching!.id)?.status).toBe("active");
  });

  it("persists an accepted coached answer as a reviewable style rule", async () => {
    const studio = await fresh();
    const snap = await studio.acceptCoaching(aiRepId, {
      sensitive: [],
      style: ["Keep it concise.", "Use a warmer tone."],
      compactedInstruction: "Keep answers concise and warm.\nExample: Happy to walk you through the approved points.",
      scope: "persona",
      sourceMessage: "What is Milvexian?",
    });
    const rule = snap?.rules.find((r) => r.origin === "coaching" && r.type === "persona_style");
    expect(rule?.status).toBe("draft");
    expect(rule?.instruction).toContain("Keep answers concise and warm");
    expect(rule?.sourceFeedback).toBe("Keep it concise. / Use a warmer tone.");
    expect((await studio.get(aiRepId))?.rules.find((r) => r.id === rule?.id)?.instruction).toContain("Example:");
  });

  it("persists the guided overview plan used by deck walkthrough rehearsal", async () => {
    const studio = await fresh();
    const snap = await studio.setGuidedOverviewPlan(aiRepId, {
      steps: [
        { id: "step_1", title: "Program first", slideId: "slide_program", instruction: "Start with slide 3 for this section." },
        { id: "step_2", title: "Mechanism second", slideId: "slide_moa", instruction: "Then explain the mechanism slide." },
      ],
    });

    expect(snap?.guidedOverview.steps[0]?.slideId).toBe("slide_program");
    expect(snap?.guidedOverview.steps[0]?.instruction).toContain("slide 3");
    expect((await studio.get(aiRepId))?.guidedOverview.steps[1]?.slideId).toBe("slide_moa");
  });
});
