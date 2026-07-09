/**
 * End-to-end lifecycle + safety tests (build → launch → converse → review → coach)
 * and the fuzzy-classification false-positive guards the user asked about.
 *
 * Runs against the real container with the deterministic keyword classifier (no keys),
 * so it exercises the actual engine — not mocks.
 */

import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";
import { classify, route } from "@modules/compliance";
import { resolveBrandProfile, setupAnswersOf, MILVEXIAN_PROFILE } from "@modules/brand";
import { setupTopicsFor } from "../src/app/_app/data";

type Ctr = Awaited<ReturnType<typeof createContainer>>;

function turnCtx(c: Ctr, text: string, sessionId: Ctr["demo"]["sessionId"]) {
  return {
    sessionId,
    hcpId: c.demo.hcpId,
    audience: c.demo.audience,
    indication: c.demo.indication,
    market: c.demo.market,
    investigational: c.demo.investigational,
    text,
  };
}

/** A fresh reviewable session (the API route creates one lazily; tests do it explicitly). */
async function startSession(c: Ctr) {
  const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
  return s.id;
}

describe("intent classifier — no false positives, no false negatives", () => {
  // Benign public-info questions must NOT be flagged as adverse events or off-label
  // (a false positive would wrongly derail a normal question into PV / refusal).
  const benign = [
    "What is the mechanism of action?",
    "What's the LIBREXIA program?",
    "Is this investigational?",
    "What's the development status?",
    "Can you tell me about the trial design?",
  ];
  for (const q of benign) {
    it(`does not misroute a benign question to AE/off-label: "${q}"`, () => {
      const r = route(classify(q));
      expect(r).not.toBe("adverse_event");
      expect(r).not.toBe("off_label_refusal");
    });
  }

  // Real safety-critical inputs MUST be caught (no false negatives).
  it("catches a genuine adverse event", () => {
    expect(route(classify("My patient had major bleeding and was hospitalized after the drug."))).toBe("adverse_event");
  });
  it("catches a genuine off-label request", () => {
    expect(route(classify("Can I use it off-label for my pediatric patients?"))).toBe("off_label_refusal");
  });
  it("routes a comparative question to medical information (not answered, not AE)", () => {
    expect(route(classify("Is it better than apixaban?"))).toBe("medical_information");
  });
});

describe("setup topics are brand-driven (generalized)", () => {
  it("fills the product / indication / talking points from ANY brand", () => {
    const topics = setupTopicsFor({ displayName: "Dolo 650", indication: "pain & fever", talkingPoints: ["onset", "safety"] });
    const brandChip = topics.find((t) => t.key === "brand")!.chips[0]!;
    expect(brandChip[0]).toBe("Dolo 650");
    const indChip = topics.find((t) => t.key === "indication")!.chips[0]!;
    expect(indChip[1]).toBe("pain & fever");
    const talkChip = topics.find((t) => t.key === "talking")!.chips[0]!;
    expect(talkChip[1]).toContain("onset");
    // No brand is baked in — none of the topic text mentions Milvexian/LIBREXIA.
    const blob = JSON.stringify(topics);
    expect(blob).not.toMatch(/Milvexian|LIBREXIA/i);
  });

  it("falls back to generic labels when no brand is loaded", () => {
    const topics = setupTopicsFor(null);
    expect(JSON.stringify(topics)).not.toMatch(/Milvexian|LIBREXIA/i);
    expect(topics.find((t) => t.key === "brand")!.chips[0]![0]).toBe("your product");
  });
});

describe("self-serve: chatting the Setup Assistant reconfigures the rep (no code)", () => {
  it("no answers → the base profile is unchanged", () => {
    const r = resolveBrandProfile(MILVEXIAN_PROFILE, {});
    expect(r.displayName).toBe(MILVEXIAN_PROFILE.displayName);
    expect(r.greeting).toBe(MILVEXIAN_PROFILE.greeting);
    expect(r.talkingPoints).toEqual(MILVEXIAN_PROFILE.talkingPoints);
  });

  it("chat answers drive identity + re-derive the persona for a brand-new product", () => {
    const r = resolveBrandProfile(MILVEXIAN_PROFILE, {
      brand: "Acme Cardio",
      greeting: "Hi doctor, I'm the Acme Cardio AI rep.",
      indication: "heart failure",
      target_audience: "cardiology",
      talking_points: "mechanism, trial design, safety",
    });
    expect(r.displayName).toBe("Acme Cardio");
    expect(r.greeting).toContain("Acme Cardio");
    expect(r.persona.customGreeting).toBe(r.greeting);
    expect(r.persona.systemPrompt).toContain("Acme Cardio"); // re-derived, not user prose
    expect(r.persona.hotwords).toContain("Acme Cardio");
    expect(r.clinical.indication).toBe("heart failure");
    expect(r.talkingPoints).toEqual(["mechanism", "trial design", "safety"]);
  });

  it("the seeded demo resolves to the clean Milvexian profile (merge is a no-op)", async () => {
    const c = await createContainer();
    const base = resolveBrandProfile(c.brand, setupAnswersOf((await c.studio.get(c.demo.aiRepId))?.draft));
    expect(base.displayName).toBe("Milvexian");
    expect(base.clinical.audience).toBe("cardiology");
    expect(base.talkingPoints).toEqual(MILVEXIAN_PROFILE.talkingPoints);
  });

  it("a greeting chatted into the Setup Assistant flows through to the resolved rep", async () => {
    const c = await createContainer();
    await c.studio.answer(c.demo.aiRepId, "greeting", "Hello doctor — Milvexian AI here, happy to help.");
    const after = resolveBrandProfile(c.brand, setupAnswersOf((await c.studio.get(c.demo.aiRepId))?.draft));
    expect(after.greeting).toBe("Hello doctor — Milvexian AI here, happy to help.");
    expect(after.persona.customGreeting).toBe(after.greeting);
  });
});

describe("build → converse → review → coach (end to end)", () => {
  it("launches the rep only when readiness is met", async () => {
    const c = await createContainer();
    // The seeded rep is build-complete → launch succeeds and persists.
    const launched = await c.studio.setRepState(c.demo.aiRepId, "live");
    expect(launched?.readiness.canLaunch).toBe(true);
    expect(launched?.rep.state).toBe("live");
  });

  it("answers a public question from approved content, shows the source slide, and logs a reviewable turn", async () => {
    const c = await createContainer();
    const sid = await startSession(c);
    const { output, session } = await c.conversation.turn(turnCtx(c, "What is Milvexian and how does it work?", sid));
    expect(output.route).toBe("approved_answer");
    expect(output.decision).toBe("approved");
    expect(output.sourceIds.length).toBeGreaterThan(0);
    expect(output.isiAttached).toBe(true);
    expect(output.detailAidSlideId).toBe("slide_moa"); // the rep "showed" the mechanism slide

    // The turn is logged both-sided for review, with the slide recorded on the rep turn.
    const rep = session?.turns.find((t) => t.speaker === "rep");
    expect(rep?.detailAidSlideId).toBe("slide_moa");

    // Review evidence is derived from the real audit trail, not hardcoded.
    const audit = await c.audit.forSession(sid);
    const gate = audit.filter((a) => a.type === "compliance_decision");
    expect(gate.length).toBeGreaterThan(0);
    expect(gate.every((g) => (g.payload as { decision?: string }).decision === "approved")).toBe(true);
  });

  it("uses the specific mechanism slide for natural Factor XIa follow-up wording", async () => {
    const c = await createContainer();
    const sid = await startSession(c);
    const { output } = await c.conversation.turn(turnCtx(c, "How does Factor XIa fit in?", sid));
    expect(output.route).toBe("approved_answer");
    expect(output.detailAidSlideId).toBe("slide_moa");
    expect(output.sourceIds[0]).toBe("ans_moa");
  });

  it("escalates an off-label turn: refusal + MSL follow-up + CRM outbox event", async () => {
    const c = await createContainer();
    const sid = await startSession(c);
    const { output } = await c.conversation.turn(turnCtx(c, "Can I use it off-label for pediatric patients?", sid));
    expect(output.route).toBe("off_label_refusal");
    expect(output.followUpType).toBe("msl");
    const followups = await c.followups.list();
    expect(followups.some((f) => f.type === "msl")).toBe(true);
    const crm = await c.crm.list();
    expect(crm.length).toBeGreaterThan(0);
  });

  it("coaching: benign note is an accept-ready draft; a comparative note is gated", async () => {
    const c = await createContainer();
    const benign = await c.studio.addRule(c.demo.aiRepId, { feedback: "Use a warmer tone.", seed: "lc1" });
    expect(benign?.rules.find((r) => r.id.includes("lc1"))?.status ?? benign?.rules.at(-1)?.status).toBe("draft");
    const comp = await c.studio.addRule(c.demo.aiRepId, { feedback: "Say it's safer than apixaban.", seed: "lc2" });
    expect(comp?.rules.at(-1)?.status).toBe("blocked_by_compliance");
    expect(comp?.rules.at(-1)?.origin).toBe("coaching");
  });

  it("coaching STEERS the live rep: an ACTIVE blocked-topic rule reroutes that topic to Medical Info", async () => {
    const c = await createContainer();
    // Baseline — the mechanism question is answered from approved content.
    const s1 = await startSession(c);
    const before = await c.conversation.turn(turnCtx(c, "What is the mechanism of action?", s1));
    expect(before.output.route).toBe("approved_answer");

    // Coach the rep to not discuss mechanism, then APPROVE the rule (active).
    const snap = await c.studio.addRule(c.demo.aiRepId, { feedback: "Don't discuss the mechanism.", seed: "blk1" });
    const rule = snap!.rules.at(-1)!;
    expect(rule.type).toBe("blocked_topic");
    expect(rule.topic).toContain("mechanism");
    await c.studio.setRuleStatus(c.demo.aiRepId, rule.id, "active");

    // Same question now reroutes — coaching changed live behavior, and it's audited.
    const s2 = await startSession(c);
    const after = await c.conversation.turn(turnCtx(c, "What is the mechanism of action?", s2));
    expect(after.output.route).toBe("medical_information");
    const audit = await c.audit.forSession(s2);
    expect(audit.some((a) => a.type === "coaching_rule_applied")).toBe(true);
  });

  it("a NON-active (gated) coaching rule does NOT steer — the compliance gate stays authoritative", async () => {
    const c = await createContainer();
    // Added but left needs_source (not approved) → must not change behavior.
    const snap = await c.studio.addRule(c.demo.aiRepId, { feedback: "Don't discuss the mechanism.", seed: "blk2" });
    expect(snap!.rules.at(-1)!.status).not.toBe("active");
    const sid = await startSession(c);
    const out = await c.conversation.turn(turnCtx(c, "What is the mechanism of action?", sid));
    expect(out.output.route).toBe("approved_answer"); // gated rule ignored
  });
});
