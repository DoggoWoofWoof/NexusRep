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

type ResilientState = {
  readonly memory: MemoryRepositoryFactory;
  useMemory: boolean;
  warned: boolean;
};

function isPgliteBootAbort(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /RuntimeError:\s*Aborted|Aborted\(\)|pglite.*abort|wasm.*abort/i.test(message);
}

class ResilientRepository<T extends Entity> implements Repository<T> {
  constructor(
    private readonly primary: Repository<T>,
    private readonly fallback: Repository<T>,
    private readonly state: ResilientState,
  ) {}

  private async run<R>(op: (repo: Repository<T>) => Promise<R>): Promise<R> {
    if (this.state.useMemory) return op(this.fallback);
    try {
      return await op(this.primary);
    } catch (error) {
      if (!isPgliteBootAbort(error)) throw error;
      this.state.useMemory = true;
      if (!this.state.warned) {
        this.state.warned = true;
        console.warn("[repository] PGlite aborted; using in-memory store for this process. Existing .nexusrep-data was left untouched.");
      }
      return op(this.fallback);
    }
  }

  get(id: string): Promise<T | null> {
    return this.run((repo) => repo.get(id));
  }

  list(query?: Parameters<Repository<T>["list"]>[0]): Promise<T[]> {
    return this.run((repo) => repo.list(query));
  }

  insert(entity: T): Promise<T> {
    return this.run((repo) => repo.insert(entity));
  }

  update(id: string, patch: Partial<T>): Promise<T | null> {
    return this.run((repo) => repo.update(id, patch));
  }

  delete(id: string): Promise<boolean> {
    return this.run((repo) => repo.delete(id));
  }
}

export class ResilientPgRepositoryFactory implements RepositoryFactory {
  private readonly pg: PgRepositoryFactory;
  private readonly state: ResilientState;

  constructor(namespace = "") {
    this.pg = new PgRepositoryFactory(namespace);
    this.state = { memory: new MemoryRepositoryFactory(), useMemory: false, warned: false };
  }

  create<T extends Entity>(name: string): Repository<T> {
    return new ResilientRepository<T>(this.pg.create<T>(name), this.state.memory.create<T>(name), this.state);
  }

  createAppendOnly<T extends Entity>(name: string): Repository<T> {
    return new ResilientRepository<T>(this.pg.createAppendOnly<T>(name), this.state.memory.createAppendOnly<T>(name), this.state);
  }
}

export function getRepositoryFactory(): RepositoryFactory {
  return env.dataDriver === "postgres" ? new ResilientPgRepositoryFactory() : new MemoryRepositoryFactory();
}

export { getDb, __resetDbForTests } from "./pglite";
export { PgRepository } from "./pg-repository";
