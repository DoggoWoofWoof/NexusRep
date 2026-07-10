/**
 * Approved-content revision loop ("changes go through MLR", made real):
 * revise an ACTIVE passage → new version lands in MLR review → approving it
 * retires the superseded version atomically → exactly one version retrievable.
 */
import { describe, expect, it } from "vitest";
import { asId, newId } from "@lib/ids";
import { ContentService, isRetrievable, type ApprovedAnswer } from "@modules/content";
import { MlrService } from "@modules/mlr";

function activeAnswer(text: string): ApprovedAnswer {
  return {
    id: newId<"approved_answer_id">("ans_orig"),
    tenantId: asId("tenant_t"),
    brandId: asId("brand_b"),
    campaignId: asId("camp_c"),
    contentAssetId: asId("asset_a"),
    topic: "mechanism",
    text,
    detailAidSlideId: asId("slide_moa"),
    mlr: { mlrApprovalId: asId("mlr_1"), status: "active", version: 1, audience: "Cardiology", indication: "af", market: "US", expiresAt: null, sourceFile: "deck.pptx" },
  };
}

describe("approved-content revision → MLR → supersede", () => {
  it("runs the full loop: revise → in_mlr v2 → approve → v1 retired, v2 active", async () => {
    const content = new ContentService();
    const original = await content.addAnswer(activeAnswer("Original approved mechanism text."));
    const mlr = new MlrService(content);

    const revision = await content.reviseAnswer(original.id, "Revised mechanism text with updated framing.");
    expect("error" in revision).toBe(false);
    const rev = revision as ApprovedAnswer;
    expect(rev.mlr.status).toBe("in_mlr"); // NOT live yet — current text keeps speaking
    expect(rev.mlr.version).toBe(2);
    expect(rev.supersedes).toBe(original.id);
    expect(rev.detailAidSlideId).toBe(original.detailAidSlideId); // keeps slide/topic/scope
    expect((await mlr.listPending()).some((a) => a.id === rev.id)).toBe(true);

    await mlr.approve(rev.id);
    const v1 = await content.getAnswer(original.id);
    const v2 = await content.getAnswer(rev.id);
    expect(v1?.mlr.status).toBe("retired"); // atomically superseded
    expect(v2?.mlr.status).toBe("active");
    // Exactly ONE retrievable version of the passage.
    const retrievable = (await content.listAnswers()).filter((a) => isRetrievable(a.mlr) && a.detailAidSlideId === original.detailAidSlideId);
    expect(retrievable.map((a) => a.text)).toEqual(["Revised mechanism text with updated framing."]);
  });

  it("rejecting a revision leaves the current approved text untouched", async () => {
    const content = new ContentService();
    const original = await content.addAnswer(activeAnswer("Stays live."));
    const mlr = new MlrService(content);
    const rev = (await content.reviseAnswer(original.id, "Bad revision.")) as ApprovedAnswer;
    await mlr.reject(rev.id);
    expect((await content.getAnswer(original.id))?.mlr.status).toBe("active");
    expect((await content.getAnswer(rev.id))?.mlr.status).toBe("retired");
  });

  it("fails safe: no revision of non-active passages, empty text, or identical text", async () => {
    const content = new ContentService();
    const original = await content.addAnswer(activeAnswer("Current text."));
    expect(await content.reviseAnswer(asId("ans_missing"), "x")).toMatchObject({ error: expect.stringContaining("not found") });
    expect(await content.reviseAnswer(original.id, "   ")).toMatchObject({ error: expect.stringContaining("empty") });
    expect(await content.reviseAnswer(original.id, "Current   text.")).toMatchObject({ error: expect.stringContaining("identical") });
    const retiredRev = (await content.reviseAnswer(original.id, "v2")) as ApprovedAnswer;
    expect(await content.reviseAnswer(retiredRev.id, "cannot revise a draft")).toMatchObject({ error: expect.stringContaining("ACTIVE") });
  });
});

// ── Seed-if-absent: reviewer decisions must survive restarts ──────────────────────────
// The Postgres driver's insert is an UPSERT, and the boot seeder used to re-add the seed
// content every start — resurrecting passages MLR had retired/superseded (found live:
// a superseded seed passage came back ACTIVE after a dev-server restart).
import { MemoryRepositoryFactory, type Entity, type Repository } from "@lib/repository";
import { createContainer } from "@lib/container";

/** Memory factory that behaves like a DATABASE: the same table name returns the same
 *  store across create() calls, so two containers on one factory simulate a restart. */
class SharedMemoryFactory extends MemoryRepositoryFactory {
  private readonly tables = new Map<string, Repository<Entity>>();
  override create<T extends Entity>(name: string): Repository<T> {
    if (!this.tables.has(name)) this.tables.set(name, super.create(name) as Repository<Entity>);
    return this.tables.get(name) as Repository<T>;
  }
}

describe("boot seeding never overwrites MLR decisions", () => {
  it("a retired seed passage stays retired across a container rebuild (restart)", async () => {
    const repos = new SharedMemoryFactory();
    const a = await createContainer({ repos });
    const seeded = (await a.content.listAnswers()).find((x) => x.topic === "mechanism")!;
    expect(seeded.mlr.status).toBe("active");
    await a.mlr.reject(seeded.id); // reviewer retires it
    const b = await createContainer({ repos }); // "restart"
    const after = await b.content.getAnswer(seeded.id);
    expect(after?.mlr.status).toBe("retired"); // seeding did NOT resurrect it
  });

  it("content approved AFTER boot is still retrievable after a restart (index rebuilds)", async () => {
    // The vector index is in-memory; boot must rebuild it from the STORE — a restart used
    // to silently drop approved uploads/revisions from retrieval (found live).
    const repos = new SharedMemoryFactory();
    const a = await createContainer({ repos });
    const seeded = (await a.content.listAnswers()).find((x) => x.topic === "mechanism")!;
    const rev = (await a.content.reviseAnswer(seeded.id, "Revised mechanism wording: selective Factor XIa inhibition, distinctivetestphrase.")) as ApprovedAnswer;
    await a.mlr.approve(rev.id);

    const b = await createContainer({ repos }); // "restart"
    const session = await b.conversation.start({ aiRepId: b.demo.aiRepId, hcpId: b.demo.hcpId });
    const { output } = await b.conversation.turn({
      sessionId: session.id,
      hcpId: b.demo.hcpId,
      audience: b.demo.audience,
      indication: b.demo.indication,
      market: b.demo.market,
      investigational: b.demo.investigational,
      text: "How does the mechanism of action work?",
    });
    expect(output.responseText).toContain("distinctivetestphrase"); // the revision, post-restart
  });
});
