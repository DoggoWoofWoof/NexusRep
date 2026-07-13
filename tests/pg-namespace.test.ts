/**
 * Per-user Postgres persistence: a namespaced PgRepositoryFactory keeps each signed-in user's
 * data in its OWN tables (u_<user>_*) within one PGlite database, so users are isolated and their
 * data survives restarts. Same collection + same id in two namespaces must not collide.
 */

import { afterAll, describe, expect, it } from "vitest";
import { PgRepositoryFactory, __resetDbForTests } from "@lib/db";

interface Doc extends Record<string, unknown> { id: string; v: number }

afterAll(async () => { await __resetDbForTests(); });

describe("per-user Postgres namespacing", () => {
  it("isolates the same collection + id across namespaces", async () => {
    const alice = new PgRepositoryFactory("u_alice_").create<Doc>("sessions");
    const bob = new PgRepositoryFactory("u_bob_").create<Doc>("sessions");

    await alice.insert({ id: "s1", v: 1 });
    expect((await alice.list()).length).toBe(1);
    expect((await bob.list()).length).toBe(0); // bob's namespace is a separate table

    await bob.insert({ id: "s1", v: 2 }); // same id, different namespace — no collision
    expect((await alice.get("s1"))?.v).toBe(1);
    expect((await bob.get("s1"))?.v).toBe(2);
  });

  it("a fresh factory for the same namespace sees the already-persisted rows (survives 'restart')", async () => {
    const write = new PgRepositoryFactory("u_carol_").create<Doc>("studio");
    await write.insert({ id: "rep", v: 7 });
    // A brand-new factory instance for the same namespace = the same tables (persistence).
    const reopened = new PgRepositoryFactory("u_carol_").create<Doc>("studio");
    expect((await reopened.get("rep"))?.v).toBe(7);
  });
});
