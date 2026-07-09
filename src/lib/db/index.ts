/**
 * Repository factory resolution. `NEXUSREP_DATA_DRIVER=postgres` persists all
 * canonical state to embedded Postgres (PGlite); the default `memory` keeps the
 * zero-setup in-memory stores. Services never see this choice — they take a
 * RepositoryFactory (brief §15).
 */

import { env } from "@lib/env";
import { MemoryRepositoryFactory, type Entity, type Repository, type RepositoryFactory } from "@lib/repository";
import { getDb } from "./pglite";
import { PgRepository } from "./pg-repository";

export class PgRepositoryFactory implements RepositoryFactory {
  create<T extends Entity>(name: string): Repository<T> {
    return new PgRepository<T>(getDb, name, false);
  }
  createAppendOnly<T extends Entity>(name: string): Repository<T> {
    return new PgRepository<T>(getDb, name, true);
  }
}

export function getRepositoryFactory(): RepositoryFactory {
  return env.dataDriver === "postgres" ? new PgRepositoryFactory() : new MemoryRepositoryFactory();
}

export { getDb, __resetDbForTests } from "./pglite";
export { PgRepository } from "./pg-repository";
