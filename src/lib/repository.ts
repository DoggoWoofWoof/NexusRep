/**
 * Repository abstraction. Modules depend on the `Repository<T>` interface, never
 * on a concrete store. The first implementation is in-memory; a Postgres-backed
 * implementation can be dropped in without touching business logic (brief §15).
 *
 * Canonical truth lives behind this interface. The vector index (see
 * `VectorIndex`) only ever returns candidate IDs — it is never product truth.
 */

export interface Entity {
  id: string;
}

export interface Query<T> {
  where?: Partial<T>;
  limit?: number;
}

export interface Repository<T extends Entity> {
  get(id: string): Promise<T | null>;
  list(query?: Query<T>): Promise<T[]>;
  insert(entity: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T | null>;
  /** Append-only stores (audit/event log) reject this; see AppendOnlyRepository. */
  delete(id: string): Promise<boolean>;
}

/** In-memory repository. Deterministic ordering by insertion. */
export class InMemoryRepository<T extends Entity> implements Repository<T> {
  protected readonly store = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    return this.store.get(id) ?? null;
  }

  async list(query?: Query<T>): Promise<T[]> {
    let rows = [...this.store.values()];
    if (query?.where) {
      const where = query.where;
      rows = rows.filter((row) =>
        (Object.keys(where) as (keyof T)[]).every((k) => row[k] === where[k]),
      );
    }
    return query?.limit ? rows.slice(0, query.limit) : rows;
  }

  async insert(entity: T): Promise<T> {
    this.store.set(entity.id, entity);
    return entity;
  }

  async update(id: string, patch: Partial<T>): Promise<T | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    this.store.set(id, next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}

/**
 * Append-only repository for the audit/event log. Updates and deletes are
 * rejected — corrections are appended as new correction events (brief §15, §11
 * "immutable audit").
 */
export class AppendOnlyRepository<T extends Entity> extends InMemoryRepository<T> {
  override async update(): Promise<T | null> {
    throw new Error("AppendOnlyRepository: records are immutable; append a correction event instead");
  }

  override async delete(): Promise<boolean> {
    throw new Error("AppendOnlyRepository: records are immutable and cannot be deleted");
  }
}

/**
 * Builds repositories for a named collection. Services depend on this, not on a
 * concrete store, so switching memory→Postgres is one injection at the container
 * (brief §15). Each `name` maps to a table/namespace in the backing store.
 */
export interface RepositoryFactory {
  create<T extends Entity>(name: string): Repository<T>;
  createAppendOnly<T extends Entity>(name: string): Repository<T>;
}

/** Default factory — in-memory stores. Used by tests and the memory data driver. */
export class MemoryRepositoryFactory implements RepositoryFactory {
  create<T extends Entity>(_name: string): Repository<T> {
    return new InMemoryRepository<T>();
  }
  createAppendOnly<T extends Entity>(_name: string): Repository<T> {
    return new AppendOnlyRepository<T>();
  }
}
