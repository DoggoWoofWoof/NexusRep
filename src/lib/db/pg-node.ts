/**
 * Managed-Postgres driver via node-postgres (`pg`). Selected when DATABASE_URL is set — points the
 * SAME PgRepository (plain-Postgres SQL) at a hosted Postgres (Neon / Supabase / Render / RDS …)
 * instead of embedded PGlite, so canonical state survives restarts AND can be shared across
 * instances. One shared connection Pool per process; per-user isolation is a table-name prefix on
 * that one pool (mirrors the PGlite path), NOT a connection per user.
 *
 * Only the tiny `SqlHandle` slice is implemented: `.exec` (CREATE TABLE) → `pool.query`, and `.query`
 * mapping node-pg's `{ rows, rowCount }` → `{ rows, affectedRows }`. No pgvector, no LISTEN/NOTIFY,
 * no transactions — PgRepository never uses them.
 */

import { env } from "@lib/env";
import type { SqlHandle } from "./pg-repository";

/** SSL is required by every managed Postgres (Neon/Supabase/Render/RDS) but not by a local server.
 *  Honour an explicit sslmode; otherwise default to SSL unless the host is loopback. */
function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
  if (/\bsslmode=disable\b/i.test(url)) return undefined;
  if (/\bsslmode=(require|verify-ca|verify-full|prefer)\b/i.test(url)) return { rejectUnauthorized: false };
  return /@(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(url) ? undefined : { rejectUnauthorized: false };
}

/** Build a node-pg-backed SqlHandle for an explicit URL. Exported so tests can point it at a
 *  throwaway Postgres (e.g. pglite-socket) without going through the env singleton. `end()` closes
 *  the pool (graceful shutdown / test teardown); it is intentionally NOT part of SqlHandle, which is
 *  only the slice PgRepository consumes. */
export async function createNodePgHandle(url: string): Promise<SqlHandle & { end: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: Number(process.env.NEXUSREP_PG_POOL_MAX ?? 10),
    // A hosted DB waking up (Neon/Render cold start) can take a few seconds; don't fail the first
    // request too eagerly, but don't hang forever either.
    connectionTimeoutMillis: Number(process.env.NEXUSREP_PG_CONNECT_TIMEOUT_MS ?? 10_000),
    idleTimeoutMillis: 30_000,
  });
  // A pool 'error' on an idle client would otherwise crash the process; log and let the pool recover.
  pool.on("error", (e) => console.error("[pg] idle client error:", e instanceof Error ? e.message : e));
  return {
    exec: (sql: string) => pool.query(sql),
    async query<R>(sql: string, params?: unknown[]) {
      const r = await pool.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as R[], affectedRows: r.rowCount ?? undefined };
    },
    end: () => pool.end(),
  };
}

type NodePgGlobal = typeof globalThis & { __nexusrepPgPool?: Promise<SqlHandle> | null };
const g = globalThis as NodePgGlobal;

/** Lazily-created, process-cached node-pg handle from DATABASE_URL. Mirrors pglite.getDb()'s
 *  singleton shape so it is a drop-in for PgRepositoryFactory. */
export function getNodePgDb(): Promise<SqlHandle> {
  if (!g.__nexusrepPgPool) {
    g.__nexusrepPgPool = createNodePgHandle(env.databaseUrl).catch((error) => {
      g.__nexusrepPgPool = null; // let the next request retry a transient connection failure
      throw error;
    });
  }
  return g.__nexusrepPgPool;
}

/** Test/reset helper — drops the cached pool so a fresh connection is built. */
export function __resetNodePgForTests(): void {
  g.__nexusrepPgPool = null;
}
