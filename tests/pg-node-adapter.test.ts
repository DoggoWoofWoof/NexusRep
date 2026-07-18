/**
 * node-postgres (managed-Postgres) adapter — validated END-TO-END against a REAL Postgres wire
 * protocol, not a mock. pglite-socket serves an in-process PGlite over TCP, and the ACTUAL node-pg
 * client (the same createNodePgHandle the app uses when DATABASE_URL is set) drives PgRepository
 * through it. This proves the whole path a hosted Postgres would exercise: connection + the
 * rowCount→affectedRows shim + the plain-Postgres SQL (bigserial, `on conflict do update`,
 * `data::jsonb->>'k'`, `order by ord`) + append-only immutability + per-user table-prefix isolation.
 *
 * If pglite-socket can't bind/serve in this environment the suite fails loudly (no silent skip) so a
 * regression can't hide behind "the DB test didn't run".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createNodePgHandle } from "@lib/db/pg-node";
import { PgRepository, type SqlHandle } from "@lib/db/pg-repository";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

let db: PGlite;
let server: PGLiteSocketServer;
let handle: SqlHandle & { end: () => Promise<void> };

const repo = <T extends { id: string }>(table: string, appendOnly = false) =>
  new PgRepository<T>(() => Promise.resolve(handle), table, appendOnly);

beforeAll(async () => {
  db = await PGlite.create();
  const port = await freePort();
  server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 5 });
  await server.start();
  process.env.NEXUSREP_PG_POOL_MAX = "1"; // one connection — matches PGlite's single-writer nature
  handle = await createNodePgHandle(`postgres://postgres@127.0.0.1:${port}/postgres`);
}, 30_000);

afterAll(async () => {
  await handle?.end().catch(() => {});
  await server?.stop().catch(() => {});
  await db?.close().catch(() => {});
});

describe("node-pg adapter — real Postgres wire protocol via pglite-socket", () => {
  it("does CRUD, preserves insertion order, and filters by jsonb metadata", async () => {
    const r = repo<{ id: string; name: string; n: number }>("items");
    await r.insert({ id: "a", name: "Alice", n: 1 });
    await r.insert({ id: "b", name: "Bob", n: 2 });
    await r.insert({ id: "c", name: "Cara", n: 1 });

    expect(await r.get("a")).toEqual({ id: "a", name: "Alice", n: 1 });
    expect(await r.get("missing")).toBeNull();

    // order by ord = insertion order (matches InMemoryRepository semantics)
    expect((await r.list()).map((x) => x.id)).toEqual(["a", "b", "c"]);
    // where filter via data::jsonb->>'n'
    expect((await r.list({ where: { n: 1 } })).map((x) => x.id)).toEqual(["a", "c"]);
    // limit
    expect((await r.list({ limit: 2 })).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("upserts on insert of an existing id (seeding depends on this), and merges on update", async () => {
    const r = repo<{ id: string; name: string; n?: number }>("upserts");
    await r.insert({ id: "x", name: "first" });
    await r.insert({ id: "x", name: "second" }); // on conflict do update
    expect(await r.get("x")).toEqual({ id: "x", name: "second" });
    expect((await r.list()).length).toBe(1); // replaced, not duplicated

    const merged = await r.update("x", { n: 9 });
    expect(merged).toEqual({ id: "x", name: "second", n: 9 });
    expect(await r.update("nope", { n: 1 })).toBeNull();
  });

  it("maps node-pg rowCount → affectedRows on delete", async () => {
    const r = repo<{ id: string }>("deletes");
    await r.insert({ id: "d1" });
    expect(await r.delete("d1")).toBe(true); // rowCount 1 → affectedRows 1
    expect(await r.delete("d1")).toBe(false); // rowCount 0 → affectedRows 0
    expect(await r.get("d1")).toBeNull();
  });

  it("append-only rejects update/delete (audit immutability)", async () => {
    const a = repo<{ id: string; kind: string }>("audit", true);
    await a.insert({ id: "e1", kind: "classification" });
    await expect(a.update("e1", { kind: "tampered" })).rejects.toThrow(/append-only/);
    await expect(a.delete("e1")).rejects.toThrow(/append-only/);
    expect(await a.get("e1")).toEqual({ id: "e1", kind: "classification" }); // untouched
  });

  it("per-user table prefixes isolate rows in the ONE shared database", async () => {
    const alice = repo<{ id: string; owner: string }>("u_alice_sessions");
    const bob = repo<{ id: string; owner: string }>("u_bob_sessions");
    await alice.insert({ id: "s1", owner: "alice" });
    await bob.insert({ id: "s1", owner: "bob" }); // same id, different namespace

    expect((await alice.get("s1"))?.owner).toBe("alice");
    expect((await bob.get("s1"))?.owner).toBe("bob");
    expect((await alice.list()).length).toBe(1); // can't see bob's row
  });
});
