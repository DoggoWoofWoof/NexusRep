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
  /** Optional table-name prefix so one PGlite database can hold isolated, PERSISTENT stores per
   *  signed-in user (e.g. "u_swastik_") — every collection becomes u_swastik_sessions, etc. */
  constructor(private readonly namespace = "") {}
  create<T extends Entity>(name: string): Repository<T> {
    return new PgRepository<T>(getDb, this.namespace + name, false);
  }
  createAppendOnly<T extends Entity>(name: string): Repository<T> {
    return new PgRepository<T>(getDb, this.namespace + name, true);
  }
}

export function getRepositoryFactory(): RepositoryFactory {
  return env.dataDriver === "postgres" ? new PgRepositoryFactory() : new MemoryRepositoryFactory();
}

export { getDb, __resetDbForTests } from "./pglite";
export { PgRepository } from "./pg-repository";
