/**
 * Embedded Postgres (PGlite) — a real Postgres engine running in-process (WASM),
 * so the `postgres` data driver needs no external server yet gives real SQL +
 * durable persistence. File-backed when PGLITE_DATA_DIR is set (survives
 * restarts); in-memory otherwise. A hosted Postgres can replace this later
 * behind the same RepositoryFactory with no service changes.
 */

import { PGlite } from "@electric-sql/pglite";

type PgliteGlobal = typeof globalThis & {
  __nexusrepPglitePromise?: Promise<PGlite> | null;
};

const g = globalThis as PgliteGlobal;

export function getDb(): Promise<PGlite> {
  if (!g.__nexusrepPglitePromise) {
    const dir = process.env.PGLITE_DATA_DIR;
    g.__nexusrepPglitePromise = Promise.resolve(dir ? new PGlite(dir) : new PGlite()).catch((error) => {
      g.__nexusrepPglitePromise = null;
      throw error;
    });
  }
  return g.__nexusrepPglitePromise;
}

/** Test/reset helper — drops the cached connection so a fresh in-memory db is built. */
export function __resetDbForTests(): void {
  g.__nexusrepPglitePromise = null;
}
