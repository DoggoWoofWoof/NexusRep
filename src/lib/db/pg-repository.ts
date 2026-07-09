/**
 * Postgres-backed Repository<T> over PGlite. Each collection is a table
 * (ord bigserial, id text primary key, data text). Objects are stored as JSON
 * text; metadata filters use jsonb extraction (`data::jsonb->>'k'`). Insertion
 * order is preserved via `ord` so behaviour matches InMemoryRepository. The
 * vector index stays separate — Postgres is the canonical truth (brief §15).
 */

import type { PGlite } from "@electric-sql/pglite";
import type { Entity, Query, Repository } from "@lib/repository";

type Row = { data: string };

/** Only allow safe identifier characters in table/column names we interpolate. */
function ident(name: string): string {
  return `"${name.replace(/[^a-zA-Z0-9_]/g, "_")}"`;
}

export class PgRepository<T extends Entity> implements Repository<T> {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly getDb: () => Promise<PGlite>,
    private readonly table: string,
    private readonly appendOnly = false,
  ) {}

  private async db(): Promise<PGlite> {
    const db = await this.getDb();
    if (!this.ready) {
      this.ready = db
        .exec(`create table if not exists ${ident(this.table)} (ord bigserial, id text primary key, data text not null)`)
        .then(() => undefined)
        .catch((error) => {
          this.ready = null;
          throw error;
        });
    }
    await this.ready;
    return db;
  }

  async get(id: string): Promise<T | null> {
    const db = await this.db();
    const r = await db.query<Row>(`select data from ${ident(this.table)} where id = $1`, [id]);
    const row = r.rows[0];
    return row ? (JSON.parse(row.data) as T) : null;
  }

  async list(query?: Query<T>): Promise<T[]> {
    const db = await this.db();
    const where = query?.where ?? {};
    const keys = Object.keys(where);
    const params: string[] = [];
    const conds = keys.map((k) => {
      params.push(String((where as Record<string, unknown>)[k]));
      return `(data::jsonb->>${literal(k)}) = $${params.length}`;
    });
    let sql = `select data from ${ident(this.table)}`;
    if (conds.length) sql += ` where ${conds.join(" and ")}`;
    sql += " order by ord";
    if (query?.limit) {
      params.push(String(query.limit));
      sql += ` limit $${params.length}`;
    }
    const r = await db.query<Row>(sql, params);
    return r.rows.map((row) => JSON.parse(row.data) as T);
  }

  async insert(entity: T): Promise<T> {
    const db = await this.db();
    await db.query(
      `insert into ${ident(this.table)} (id, data) values ($1, $2) on conflict (id) do update set data = $2`,
      [entity.id, JSON.stringify(entity)],
    );
    return entity;
  }

  async update(id: string, patch: Partial<T>): Promise<T | null> {
    if (this.appendOnly) throw new Error("append-only: records are immutable; append a correction event instead");
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    const db = await this.db();
    await db.query(`update ${ident(this.table)} set data = $2 where id = $1`, [id, JSON.stringify(next)]);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    if (this.appendOnly) throw new Error("append-only: records are immutable and cannot be deleted");
    const db = await this.db();
    const r = await db.query(`delete from ${ident(this.table)} where id = $1`, [id]);
    return (r.affectedRows ?? 0) > 0;
  }
}

/** Single-quote a string literal for safe inline use in a jsonb path. */
function literal(s: string): string {
  return `'${s.replace(/'/g, "''").replace(/[^a-zA-Z0-9_]/g, "")}'`;
}
