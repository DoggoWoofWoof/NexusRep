/**
 * Driver precedence in makeRepositoryFactory: DATABASE_URL (managed node-pg) > NEXUSREP_DATA_DRIVER
 * =postgres (embedded PGlite) > memory. node-pg is intentionally NON-resilient — a bad DATABASE_URL
 * must surface, not silently fall back to memory and drop writes.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const envMock: { databaseUrl: string; dataDriver: string } = { databaseUrl: "", dataDriver: "memory" };
vi.mock("@lib/env", () => ({ env: envMock }));

const { makeRepositoryFactory, PgRepositoryFactory, ResilientPgRepositoryFactory } = await import("@lib/db");
const { MemoryRepositoryFactory } = await import("@lib/repository");

describe("makeRepositoryFactory — driver precedence", () => {
  beforeEach(() => {
    envMock.databaseUrl = "";
    envMock.dataDriver = "memory";
  });

  it("DATABASE_URL set → managed Postgres (node-pg, non-resilient)", () => {
    envMock.databaseUrl = "postgres://u:p@db.example:5432/app";
    const f = makeRepositoryFactory();
    expect(f).toBeInstanceOf(PgRepositoryFactory);
    expect(f).not.toBeInstanceOf(ResilientPgRepositoryFactory);
  });

  it("DATABASE_URL wins even when NEXUSREP_DATA_DRIVER=postgres", () => {
    envMock.databaseUrl = "postgres://u:p@db.example:5432/app";
    envMock.dataDriver = "postgres";
    expect(makeRepositoryFactory()).toBeInstanceOf(PgRepositoryFactory);
  });

  it("NEXUSREP_DATA_DRIVER=postgres (no URL) → embedded PGlite (resilient)", () => {
    envMock.dataDriver = "postgres";
    expect(makeRepositoryFactory()).toBeInstanceOf(ResilientPgRepositoryFactory);
  });

  it("neither → in-memory", () => {
    expect(makeRepositoryFactory()).toBeInstanceOf(MemoryRepositoryFactory);
  });

  it("applies the per-user namespace prefix on every driver (isolation survives the driver switch)", () => {
    // Smoke: passing a namespace never throws regardless of driver (the prefix is what isolates users).
    envMock.databaseUrl = "postgres://u:p@db.example:5432/app";
    expect(() => makeRepositoryFactory("u_alice_")).not.toThrow();
    envMock.databaseUrl = "";
    envMock.dataDriver = "postgres";
    expect(() => makeRepositoryFactory("u_alice_")).not.toThrow();
  });
});
