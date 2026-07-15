/**
 * DYNAMIC clean-account flow (no seed content, no backend hand-editing): prove that a brand user
 * can UPLOAD a deck + extra knowledge docs for ANY drug and get a working rep — overview from the
 * deck, Q&A grounded in the uploaded KB, and navigation to the specific uploaded slide — entirely
 * through the ingest → MLR-approve → retrieve → present pipeline. Runs on a BLANK_PROFILE container
 * (what a real "clean" signed-in user gets) and repeats for a SECOND drug to prove it's drug-agnostic
 * and isolated. Lexical embeddings + deterministic builder here (Vitest), so it exercises the
 * pipeline itself; the LLM compose layer is proven separately.
 */

import { describe, it, expect } from "vitest";
import { createContainer } from "@lib/container";
import { BLANK_PROFILE } from "@modules/brand";
import { ingestSource, type RawSource } from "@modules/content";
import { asId } from "@lib/ids";
import type { MlrMetadata } from "@modules/content";

type Ctr = Awaited<ReturnType<typeof createContainer>>;

// Mirror /api/content/ingest: parse a document into in-MLR blocks, store them, then MLR-approve
// (which publishes to retrieval). No seed — everything the rep knows comes from these uploads.
async function upload(c: Ctr, kind: "ppt" | "pdf" | "faq" | "isi", title: string, text: string) {
  const clinical = c.brand.clinical;
  const mlr: MlrMetadata = {
    mlrApprovalId: asId<"mlr_approval_id">("mlr_pending"),
    status: "in_mlr",
    version: 1,
    audience: clinical.audience,
    indication: clinical.indication,
    market: clinical.market,
    expiresAt: null,
    sourceFile: title,
  };
  const raw: RawSource = { kind, title, tenantId: c.demo.tenantId, brandId: c.demo.brandId, campaignId: c.demo.campaignId, text, mlr };
  const seed = `up_${title.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const result = ingestSource(raw, seed, { topicHints: c.brand.lexicon.topicSynonyms });
  await c.content.addAsset(result.asset);
  for (const s of result.slides) await c.content.addSlide(s);
  for (const a of result.answers) await c.content.addAnswer(a);
  for (const s of result.safety) await c.content.addSafetyStatement(s);
  // MLR sign-off → active + published to the retrieval index (as POST /api/mlr does).
  for (const a of result.answers) await c.mlr.approve(a.id);
  for (const s of result.safety) await c.mlr.approveSafety(s.id);
  return result;
}

async function cleanContainer(): Promise<Ctr> {
  // Exactly what a signed-in "clean" user gets: blank brand, no seeded content, draft studio.
  return createContainer({ seedHistory: false, seedContent: false, seedStudio: "draft", brand: BLANK_PROFILE });
}

function turnCtx(c: Ctr, text: string) {
  return {
    sessionId: c.demo.sessionId,
    hcpId: c.demo.hcpId,
    audience: c.demo.audience,
    indication: c.demo.indication,
    market: c.demo.market,
    investigational: c.demo.investigational,
    text,
  };
}

describe("dynamic clean-account flow (upload → overview + KB + slide navigation)", () => {
  it("builds a working rep for an uploaded drug with NO seed content", async () => {
    const c = await cleanContainer();

    // A brand user's DECK (one blank-line-separated block per slide) …
    await upload(c, "ppt", "Zephyrol Deck", [
      "Zephyrol is an investigational oral SGLT2 modulator being studied in heart failure.",
      "Mechanism: Zephyrol modulates sodium-glucose cotransport to reduce cardiac preload; mechanistic hypothesis only, efficacy not established.",
      "The AURORA Phase 3 program studies Zephyrol in heart failure with reduced ejection fraction.",
      "Development status: investigational, not approved by the FDA; Fast Track designation granted.",
      "Important Safety Information: Zephyrol is investigational; its safety and efficacy have not been established. Report adverse events to Pharmacovigilance.",
    ].join("\n\n"));

    // … plus EXTRA knowledge that expands beyond the deck.
    await upload(c, "faq", "Zephyrol FAQ", [
      "The AURORA program enrolls approximately 8,000 participants across 20 countries and is event-driven.",
      "Zephyrol is being developed by Helios Therapeutics.",
    ].join("\n\n"));

    // Overview is generated from the uploaded content (not empty, not hard-coded).
    const overview = await c.presentation.overview({ context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market } });
    expect(overview.length).toBeGreaterThan(0);
    expect(overview.map((s) => s.text).join(" ").toLowerCase()).toContain("zephyrol");

    // Q&A is grounded in the UPLOADED KB and navigates to a specific uploaded slide.
    const moa = await c.conversation.turn(turnCtx(c, "how does Zephyrol work"));
    expect(moa.output.route).toBe("approved_answer");
    expect(moa.output.responseText.toLowerCase()).toMatch(/sodium-glucose|preload|sglt2/);
    expect(moa.output.detailAidSlideId, "navigates to a specific uploaded slide").toBeTruthy();

    // A fact that ONLY exists in the extra FAQ doc (not the deck) is answerable → KB is the source.
    const scale = await c.conversation.turn(turnCtx(c, "how many participants are in the AURORA program"));
    expect(scale.output.responseText.toLowerCase()).toMatch(/8,?000|20 countries/);

    // The uploaded ISI is captured verbatim and available.
    const isi = await c.content.latestActiveSafetyStatement();
    expect(isi?.text.toLowerCase()).toContain("safety and efficacy have not been established");
  }, 60_000);

  it("is drug-agnostic and isolated — a second clean account builds a different rep", async () => {
    const c = await cleanContainer();
    await upload(c, "ppt", "Novaclot Deck", [
      "Novaclot is an investigational monoclonal antibody being studied for hemophilia.",
      "Mechanism: Novaclot mimics activated Factor VIII to restore hemostasis; investigational, efficacy not established.",
      "The HORIZON Phase 3 program studies Novaclot for routine prophylaxis in hemophilia A.",
      "Important Safety Information: Novaclot is investigational; its safety and efficacy have not been established. Report adverse events to Pharmacovigilance.",
    ].join("\n\n"));

    const overview = await c.presentation.overview({ context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market } });
    const joined = overview.map((s) => s.text).join(" ").toLowerCase();
    expect(joined).toContain("novaclot");
    expect(joined).not.toContain("zephyrol"); // isolation — no bleed from the other account
    expect(joined).not.toContain("milvexian"); // no seed bleed either

    const moa = await c.conversation.turn(turnCtx(c, "how does Novaclot work"));
    expect(moa.output.route).toBe("approved_answer");
    expect(moa.output.responseText.toLowerCase()).toMatch(/factor viii|hemostasis|antibody|mimics/);
  }, 60_000);
});
