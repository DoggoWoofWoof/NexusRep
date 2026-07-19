/**
 * Durability for the two in-memory observability ledgers (usage cost + activity feed). They are
 * process-global buffers (fast to read/query), so instead of writing every event to Postgres on the
 * hot path, we SNAPSHOT them to one row each on a timer and HYDRATE them at boot. That keeps the
 * record() path allocation-cheap while surviving restarts/redeploys — at most one flush interval of
 * events is lost on a hard crash, which is the right trade for observability data (not billing truth).
 *
 * No-op without a managed Postgres (env.databaseUrl) — the ledgers stay purely in-memory, exactly as
 * before. All writes are best-effort: a DB hiccup must never break the app or the flows it observes.
 */

import { env } from "@lib/env";
import { logger } from "@lib/logger";
import { getUsageLedger, type UsageEvent } from "@modules/usage";
import { dumpActivity, loadActivity, type ActivityEvent } from "@modules/activity";
import type { SqlHandle } from "@lib/db/pg-repository";

const TABLE = "nexusrep_ledger_snapshots";
const log = logger.child("ledger");
let schemaReady = false;

async function handle(): Promise<SqlHandle> {
  const { getNodePgDb } = await import("@lib/db/pg-node");
  return getNodePgDb();
}

async function ensureSchema(h: SqlHandle): Promise<void> {
  if (schemaReady) return;
  await h.exec(`create table if not exists ${TABLE} (kind text primary key, data text not null, updated_at timestamptz default now())`);
  schemaReady = true;
}

/** Load persisted ledger snapshots into the in-memory stores. Call once at boot, before serving.
 *  loadEvents/loadActivity only fill an EMPTY store, so this can't clobber a live event. */
export async function hydrateLedgers(): Promise<void> {
  if (!env.databaseUrl) return;
  try {
    const h = await handle();
    await ensureSchema(h);
    const r = await h.query<{ kind: string; data: string }>(`select kind, data from ${TABLE} where kind in ('usage','activity')`);
    for (const row of r.rows) {
      try {
        const events = JSON.parse(row.data) as unknown[];
        if (row.kind === "usage") getUsageLedger().loadEvents(events as UsageEvent[]);
        else if (row.kind === "activity") loadActivity(events as ActivityEvent[]);
      } catch {
        /* a corrupt snapshot must not block boot — skip it */
      }
    }
    log.info("hydrated observability ledgers from Postgres", { snapshots: r.rows.length });
  } catch (e) {
    log.warn("ledger hydrate skipped (DB unreachable at boot) — starting empty", { error: e });
  }
}

/** Snapshot the current in-memory ledgers to Postgres (one upsert per kind). Best-effort. */
export async function persistLedgers(): Promise<void> {
  if (!env.databaseUrl) return;
  const h = await handle();
  await ensureSchema(h);
  const snapshots: [string, string][] = [
    ["usage", JSON.stringify(getUsageLedger().dumpEvents())],
    ["activity", JSON.stringify(dumpActivity())],
  ];
  for (const [kind, data] of snapshots) {
    await h.query(
      `insert into ${TABLE} (kind, data, updated_at) values ($1, $2, now()) on conflict (kind) do update set data = excluded.data, updated_at = now()`,
      [kind, data],
    );
  }
}
