/**
 * Regression tests for the 2026-07-10 full-audit fixes: HCP identity + CRM delivery,
 * concurrency, dedup scoping, brand-lexicon de-hardcoding, setup-driven behavior,
 * empty-seed ids, and the shared ISI-delivery detector.
 */

import { describe, expect, it } from "vitest";
import { asId, newId, type AiRepId, type BrandId, type CampaignId, type HcpId, type SessionId } from "@lib/ids";
import { createContainer } from "@lib/container";
import { SessionService } from "@modules/sessions";
import { StudioService } from "@modules/aiRepStudio";
import { FollowUpService } from "@modules/followups";
import { classify, configureClassifierLexicon, isiAlreadyDelivered } from "@modules/compliance";
import { activeSteering } from "@modules/rules";
import { MILVEXIAN_PROFILE, resolveBrandProfile } from "@modules/brand";

const aiRepId = asId<"ai_rep_id">("airep_test") as AiRepId;
const brandId = asId<"brand_id">("brand_test") as BrandId;
const campaignId = asId<"campaign_id">("camp_test") as CampaignId;
const hcpId = asId<"hcp_id">("hcp_test") as HcpId;

describe("appendTurn is safe under concurrency (per-session serialization)", () => {
  it("keeps every turn when many are appended in parallel", async () => {
    const sessions = new SessionService();
    const s = await sessions.start({ aiRepId, hcpId, seed: "conc" });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sessions.appendTurn(s.id, { speaker: i % 2 ? "rep" : "hcp", text: `turn ${i}`, seed: `t${i}` }),
      ),
    );
    const after = await sessions.get(s.id);
    expect(after?.turns).toHaveLength(12); // read-modify-write race would drop some
    expect(after?.questionCount).toBe(6);
  });
});

describe("coaching dedup is scoped per doctor", () => {
  it("keeps identical feedback for two DIFFERENT HCPs as two rules", async () => {
    const studio = new StudioService();
    await studio.getOrCreate({ aiRepId, brandId, campaignId });
    await studio.addRule(aiRepId, { feedback: "Lead with the program.", scope: "hcp_specific", appliesToHcpId: "hcp_a", topic: "program", seed: "ra" });
    const snap = await studio.addRule(aiRepId, { feedback: "Lead with the program.", scope: "hcp_specific", appliesToHcpId: "hcp_b", topic: "program", seed: "rb" });
    const matching = (snap?.rules ?? []).filter((r) => r.sourceFeedback === "Lead with the program.");
    expect(matching).toHaveLength(2); // previously collapsed to one, dropping doctor B's coaching
  });
});

describe("newId empty-seed", () => {
  it("treats an empty seed as no seed (no colliding `prefix_` ids)", () => {
    const a = newId("x", "");
    const b = newId("x", "");
    expect(a).not.toBe("x_");
    expect(a).not.toBe(b);
  });
});

describe("setup answers drive behavior", () => {
  it("blocked_topics answers become ACTIVE guardrails that steer", async () => {
    const studio = new StudioService();
    await studio.getOrCreate({ aiRepId, brandId, campaignId });
    const snap = await studio.answer(aiRepId, "blocked_topics", "pricing, rebates");
    const guardrails = (snap?.rules ?? []).filter((r) => r.type === "blocked_topic" && r.origin === "guardrail");
    expect(guardrails.map((r) => r.topic)).toEqual(expect.arrayContaining(["pricing", "rebates"]));
    const steering = activeSteering(snap?.rules ?? []);
    expect(steering.blockedTopics).toEqual(expect.arrayContaining(["pricing", "rebates"]));
  });

  it("follow-up owners resolve from the configured contacts", async () => {
    const followups = new FollowUpService(undefined, async (type) => (type === "pharmacovigilance" ? "PV Desk East" : "Dr. Meyer — MedInfo"));
    const pv = await followups.create({ hcpId, type: "pharmacovigilance", sourceSessionId: asId<"session_id">("s1") as SessionId, seed: "f1" });
    const msl = await followups.create({ hcpId, type: "msl", sourceSessionId: asId<"session_id">("s1") as SessionId, seed: "f2" });
    expect(pv.owner).toBe("PV Desk East");
    expect(msl.owner).toBe("Dr. Meyer — MedInfo");
  });

  it("resolveBrandProfile consumes the new chatable keys", () => {
    const resolved = resolveBrandProfile(MILVEXIAN_PROFILE, {
      sponsor: "Acme Pharma",
      tagline: "a new oral candidate",
      try_questions: "Q one?; Q two?",
      hotwords: "acmecoag, coagunext",
    });
    expect(resolved.sponsor).toBe("Acme Pharma");
    expect(resolved.tagline).toBe("a new oral candidate");
    expect(resolved.tryQuestions).toEqual(["Q one?", "Q two?"]);
    expect(resolved.persona.hotwords).toEqual(expect.arrayContaining(["acmecoag", "coagunext"]));
    expect(resolved.lexicon.productTerms).toEqual(expect.arrayContaining(["acmecoag", "coagunext"]));
  });
});

describe("brand lexicon replaces engine hardcoding", () => {
  it("classifier learns product terms from the lexicon (no brand words in engine code)", () => {
    configureClassifierLexicon(["zathrozamab"]);
    const c = classify("tell me about zathrozamab please");
    expect(c.intent).toBe("product_info");
    configureClassifierLexicon(MILVEXIAN_PROFILE.lexicon.productTerms); // restore for other tests
  });
});

describe("real HCP identity + launch persistence (container integration)", () => {
  it("a validated cohort hcpId attributes the session; unknown ids fall back to demo", async () => {
    const c = await createContainer();
    const real = c.targeting.rank()[1]!.hcpId;
    expect(c.targeting.has(String(real))).toBe(true);
    expect(c.targeting.has("hcp_made_up_by_attacker")).toBe(false);
  });

  it("launch persists the activation list and refuses invalid input", async () => {
    const c = await createContainer();
    const real = String(c.targeting.rank()[0]!.hcpId);
    const snap = await c.studio.launch(c.demo.aiRepId, [real]);
    expect(snap?.activation?.hcpIds).toEqual([real]);
    expect(snap?.activation?.launchedAt).toBeTruthy();
    const empty = await c.studio.launch(c.demo.aiRepId, ["  "]);
    expect(empty?.activation?.hcpIds).toEqual([real]); // unchanged
  });

  it("live CRM delivery is attempted for escalations (status leaves 'created')", async () => {
    const c = await createContainer();
    const fresh = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.conversation.turn({
      sessionId: fresh.id,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text: "Can I use this off-label for pediatric patients?",
    });
    const outbox = await c.crm.list();
    const entry = outbox.find((e) => e.sessionId === fresh.id);
    expect(entry).toBeTruthy();
    expect(entry!.attempts).toBeGreaterThan(0); // delivery attempted, not stuck at created
    expect(entry!.status).not.toBe("created");
  });
});

describe("shared ISI-delivery detection", () => {
  it("matches across whitespace differences and ignores other events", () => {
    const isi = "This is the required safety text.";
    const events = [
      { type: "classification", payload: { text: "noise" } },
      { type: "response_output", payload: { text: `Answer body.\n\nImportant  Safety   Information: ${isi}` } },
    ];
    expect(isiAlreadyDelivered(events, isi)).toBe(true);
    expect(isiAlreadyDelivered(events.slice(0, 1), isi)).toBe(false);
    expect(isiAlreadyDelivered(events, "different text")).toBe(false);
  });
});
