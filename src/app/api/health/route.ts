/**
 * Public health check — "is the app up, and is the database connected?" Safe to be public and to point
 * an uptime monitor (or Render's healthCheckPath) at: it reports the data driver, whether a managed
 * Postgres is configured + reachable, and a table count — but NEVER the connection string, host, or
 * credentials. Unlike /api/brand, it does not depend on auth, so it answers even when the session
 * secret isn't set. Keep it cheap: one lightweight query with a short timeout.
 */

import { NextResponse } from "next/server";
import { env } from "@lib/env";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // DATABASE_URL wins over NEXUSREP_DATA_DRIVER (see container.ts): postgres when a URL is set, else
  // embedded PGlite when the driver asks for it, else in-memory.
  const driver = env.databaseUrl ? "postgres" : env.dataDriver === "postgres" ? "pglite" : "memory";
  const database: { configured: boolean; connected?: boolean; tables?: number } = { configured: Boolean(env.databaseUrl) };

  if (env.databaseUrl) {
    try {
      const { getNodePgDb } = await import("@lib/db/pg-node");
      const handle = await getNodePgDb();
      const r = await handle.query<{ n: string }>("select count(*)::text as n from information_schema.tables where table_schema = 'public'");
      database.connected = true;
      database.tables = Number(r.rows[0]?.n ?? 0);
    } catch {
      // Reachability only — the detail (host/error) stays out of a public response; boot logs have it.
      database.connected = false;
    }
  }

  const ok = !env.databaseUrl || database.connected === true;
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      dataDriver: driver,
      database,
      // Whether the observability ledgers survive a restart (durable only when Postgres is wired).
      ledgersDurable: Boolean(env.databaseUrl),
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
