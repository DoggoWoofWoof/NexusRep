import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { PgRepository, PgRepositoryFactory, __resetDbForTests } from "@lib/db";
import { SessionService } from "@modules/sessions";
import { StudioService } from "@modules/aiRepStudio";
import { asId } from "@lib/ids";

// Each test gets a fresh in-memory embedded Postgres.
beforeEach(() => __resetDbForTests());

describe("PgRepository — real embedded Postgres semantics", () => {
  it("insert / get / insertion-order list / where filter / limit / update / delete", async () => {
    const r = new PgRepositoryFactory().create<{ id: string; market: string; n: number }>("probe");
    await r.insert({ id: "a", market: "US", n: 1 });
    await r.insert({ id: "b", market: "IN", n: 2 });
    await r.insert({ id: "c", market: "US", n: 3 });

    expect((await r.get("b"))?.n).toBe(2);
    expect((await r.list()).map((x) => x.id)).toEqual(["a", "b", "c"]); // preserves insertion order
    expect((await r.list({ where: { market: "US" } })).map((x) => x.id)).toEqual(["a", "c"]);
    expect((await r.list({ limit: 2 })).length).toBe(2);

    expect((await r.update("a", { n: 9 }))?.n).toBe(9);
    expect((await r.get("a"))?.n).toBe(9);
    expect(await r.delete("b")).toBe(true);
    expect(await r.get("b")).toBeNull();
    expect(await r.delete("does_not_exist")).toBe(false);
  });

  it("append-only repo rejects update/delete but keeps inserts", async () => {
    const log = new PgRepositoryFactory().createAppendOnly<{ id: string }>("probe_log");
    await log.insert({ id: "x" });
    await expect(log.update("x", {})).rejects.toThrow();
    await expect(log.delete("x")).rejects.toThrow();
    expect((await log.list()).length).toBe(1);
  });
});

describe("services round-trip through embedded Postgres", () => {
  it("SessionService persists sessions, turns, and folded status", async () => {
    const svc = new SessionService(new PgRepositoryFactory());
    const s = await svc.start({ aiRepId: asId("airep_pg"), hcpId: asId("hcp_pg"), seed: "pg1", startedAt: "2026-07-08T09:00:00.000Z" });
    await svc.appendTurn(s.id, { speaker: "hcp", text: "reaction?", seed: "t1" });
    await svc.recordOutcome(s.id, { route: "adverse_event", decision: "approved" });
    const got = await svc.get(s.id);
    expect(got?.turns.length).toBe(1);
    expect(got?.questionCount).toBe(1);
    expect(got?.complianceStatus).toBe("ae_routed");
    expect((await svc.list()).some((x) => x.id === s.id)).toBe(true);
  });

  it("StudioService persists compliance-classified rules", async () => {
    const studio = new StudioService(new PgRepositoryFactory());
    const rep = asId<"ai_rep_id">("airep_pg2");
    await studio.getOrCreate({ aiRepId: rep, brandId: asId("b"), campaignId: asId("c") });
    const snap = await studio.addRule(rep, { feedback: "Say Milvexian is safer than apixaban.", seed: "r1" });
    expect(snap?.rules[0]?.status).toBe("blocked_by_compliance");
    // Persisted — re-read from Postgres.
    expect((await studio.get(rep))?.rules.length).toBe(1);
  });
});

describe("Postgres durability (survives a restart)", () => {
  it("file-backed data is readable from a brand-new connection", async () => {
    const dir = `.pgtest-${Date.now()}`;
    try {
      let db = new PGlite(dir);
      await new PgRepository<{ id: string; v: number }>(async () => db, "durable").insert({ id: "keep", v: 42 });
      await db.close(); // simulate shutdown

      db = new PGlite(dir); // fresh process/connection on the same data dir
      const reread = await new PgRepository<{ id: string; v: number }>(async () => db, "durable").get("keep");
      expect(reread?.v).toBe(42);
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000); // double WASM boot is I/O-bound: generous budget so machine load never flakes it
});
