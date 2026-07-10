/**
 * Regression tests for the final bug + hardcoding audit:
 * - presentation routes classify HCP text (AE/off-label can't ride a deck command)
 * - audit seq survives restarts (no interleaved trails)
 * - keyword recovery never overrides a CONFIDENT LLM's medical-info escalation
 * - StudioService writes are serialized per rep (no lost rules)
 * - audience query comes from the brand's clinical context
 * - campaign "Day N of M" is computed, pinned by NEXUSREP_DEMO_DATE
 */

import { describe, expect, it } from "vitest";
import { POST as presentationStep } from "@/app/api/presentation/step/route";
import { AuditService } from "@modules/audit";
import { mergeWithKeywordSignals } from "@modules/compliance/classifiers";
import { classify } from "@modules/compliance";
import { audienceQueryFor, MILVEXIAN_AUDIENCE_QUERY } from "@modules/audience";
import { toPublicBrand, MILVEXIAN_PROFILE } from "@modules/brand";
import { StudioService } from "@modules/aiRepStudio";
import { MemoryRepositoryFactory, type Entity, type Repository } from "@lib/repository";
import { asId } from "@lib/ids";

/** Memory factory that behaves like a DATABASE across service instances. */
class SharedMemoryFactory extends MemoryRepositoryFactory {
  private readonly tables = new Map<string, Repository<Entity>>();
  override create<T extends Entity>(name: string): Repository<T> {
    if (!this.tables.has(name)) this.tables.set(name, super.create(name) as Repository<Entity>);
    return this.tables.get(name) as Repository<T>;
  }
  override createAppendOnly<T extends Entity>(name: string): Repository<T> {
    return this.create<T>(name);
  }
}

describe("presentation routes classify HCP-supplied text", () => {
  it("an AE mention in a deck 'jump' leaves the walkthrough for the real pipeline", async () => {
    const req = new Request("http://localhost/api/presentation/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "jump", query: "my patient had severe bleeding and swelling after taking it" }),
    });
    const res = await presentationStep(req);
    const json = (await res.json()) as { route: string; step: unknown; response: string };
    expect(json.route).toBe("adverse_event"); // routed to PV, not narrated over
    expect(json.step).toBeNull(); // no slide navigation on a safety turn
  });

  it("a plain deck command still walks the deck (no false escalation)", async () => {
    const req = new Request("http://localhost/api/presentation/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "next" }),
    });
    const res = await presentationStep(req);
    const json = (await res.json()) as { route: string; step: { index: number } | null };
    expect(json.route).toBe("approved_answer");
    expect(json.step).not.toBeNull();
  });
});

describe("audit trail ordering survives restarts", () => {
  it("a second service instance continues seq from the store instead of resetting to 0", async () => {
    const repos = new SharedMemoryFactory();
    const sid = asId<"session_id">("session_seq");
    const a = new AuditService(repos);
    await a.record(sid, "classification", { n: 1 });
    await a.record(sid, "compliance_decision", { n: 2 });

    const b = new AuditService(repos); // "restart"
    await b.record(sid, "response_output", { n: 3 });

    const trail = await b.forSession(sid);
    expect(trail.map((r) => (r.payload as { n: number }).n)).toEqual([1, 2, 3]);
    expect(trail[2]!.seq).toBeGreaterThan(trail[1]!.seq);
  });
});

describe("keyword recovery never lowers a confident LLM's medical-info signal", () => {
  it("confident LLM medicalInfoRisk >= 0.6 stands (routes to Medical Information)", () => {
    const merged = mergeWithKeywordSignals(
      {
        intent: "product_info",
        confidence: 0.85, // CONFIDENT — this is not a fallback to recover from
        offLabelRisk: 0,
        adverseEventRisk: 0,
        medicalInfoRisk: 0.7,
        promptInjectionRisk: 0,
        comparativeClaimRisk: 0,
        isiRequired: false,
      },
      classify("How does Factor XIa fit into that?"), // keyword sees the drug name
    );
    expect(merged.medicalInfoRisk).toBeGreaterThanOrEqual(0.6);
  });
});

describe("StudioService write serialization", () => {
  it("parallel rule writes all land (no lost update on the rules array)", async () => {
    const studio = new StudioService();
    const aiRepId = asId<"ai_rep_id">("airep_serial");
    await studio.getOrCreate({ aiRepId, brandId: asId("brand_x"), campaignId: asId("camp_x") });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        studio.addRule(aiRepId, { feedback: `Always mention checkpoint ${i} to the doctor.` }),
      ),
    );
    const snap = await studio.get(aiRepId);
    expect(snap!.rules.length).toBe(8);
  });
});

describe("audience query follows the brand", () => {
  it("a profile that declares targeting gets its own query; one that doesn't falls back", () => {
    const own = audienceQueryFor({ specialties: ["Oncology"], diagnosisCodes: ["C50"] });
    expect(own.specialties).toEqual(["Oncology"]);
    expect(own.diagnosisCodes).toEqual(["C50"]);
    expect(audienceQueryFor({})).toBe(MILVEXIAN_AUDIENCE_QUERY);
    expect(audienceQueryFor(undefined)).toBe(MILVEXIAN_AUDIENCE_QUERY);
  });

  it("the Milvexian profile declares its own targeting (no implicit inheritance)", () => {
    expect(MILVEXIAN_PROFILE.clinical.specialties).toContain("Cardiology");
    expect(MILVEXIAN_PROFILE.clinical.diagnosisCodes).toContain("I48");
  });
});

describe("campaign day counter is computed, not frozen", () => {
  it("Day N of M derives from the start date (pinned by NEXUSREP_DEMO_DATE)", () => {
    const prev = process.env.NEXUSREP_DEMO_DATE;
    try {
      process.env.NEXUSREP_DEMO_DATE = "2026-07-10";
      expect(toPublicBrand(MILVEXIAN_PROFILE).campaign.subtitle).toMatch(/Day 18 of 92$/);
      process.env.NEXUSREP_DEMO_DATE = "2026-06-23";
      expect(toPublicBrand(MILVEXIAN_PROFILE).campaign.subtitle).toMatch(/Day 1 of 92$/);
      process.env.NEXUSREP_DEMO_DATE = "2027-01-01";
      expect(toPublicBrand(MILVEXIAN_PROFILE).campaign.subtitle).toMatch(/Day 92 of 92$/); // clamped
    } finally {
      if (prev === undefined) delete process.env.NEXUSREP_DEMO_DATE;
      else process.env.NEXUSREP_DEMO_DATE = prev;
    }
  });
});

describe("targeting + campaign are chat-editable brand config", () => {
  it("Setup Assistant answers drive the audience query and campaign progress", async () => {
    const { resolveBrandProfile } = await import("@modules/brand");
    const r = resolveBrandProfile(MILVEXIAN_PROFILE, {
      target_specialties: "Oncology, Hematology",
      diagnosis_codes: "C50; C91",
      campaign_start: "2026-01-01",
      campaign_length: "30",
    });
    expect(r.clinical.specialties).toEqual(["Oncology", "Hematology"]);
    expect(r.clinical.diagnosisCodes).toEqual(["C50", "C91"]);
    expect(r.campaign.startDate).toBe("2026-01-01");
    expect(r.campaign.lengthDays).toBe(30);
    // The edited targeting flows into the cohort query — no Milvexian inheritance.
    expect(audienceQueryFor(r.clinical).specialties).toEqual(["Oncology", "Hematology"]);
  });

  it("malformed campaign values are ignored (base profile stands)", async () => {
    const { resolveBrandProfile } = await import("@modules/brand");
    const r = resolveBrandProfile(MILVEXIAN_PROFILE, { campaign_start: "not-a-date", campaign_length: "-5" });
    expect(r.campaign.startDate).toBe("2026-06-23");
    expect(r.campaign.lengthDays).toBe(92);
  });
});
