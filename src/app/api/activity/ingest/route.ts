/**
 * Client-beacon ingest for the activity log. The browser batches UI events (every click, navigation,
 * and API call — see lib/activity-client.ts) and POSTs them here. We stamp the acting user
 * SERVER-SIDE from the session cookie (the client can't spoof identity) and validate/clamp each event
 * before it enters the shared log.
 */

import { NextResponse } from "next/server";
import { currentUserId } from "@lib/container";
import { recordActivity, ACTIVITY_CATEGORIES, type ActivityCategory, type ActivitySeverity } from "@modules/activity";

export const dynamic = "force-dynamic";

const MAX_BATCH = 60;
const CATEGORIES = new Set<string>(ACTIVITY_CATEGORIES);
const SEVERITIES = new Set<string>(["info", "notice", "warn", "error"]);

interface RawBeacon {
  category?: unknown;
  action?: unknown;
  target?: unknown;
  sessionId?: unknown;
  severity?: unknown;
  metadata?: unknown;
  at?: unknown;
  surface?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { events?: unknown; surface?: unknown };
  const raw: RawBeacon[] = Array.isArray(body?.events) ? (body.events as RawBeacon[]).slice(0, MAX_BATCH) : [];
  const batchSurface = body?.surface === "doctor" ? "doctor" : "brand";
  // Identity is server-authoritative: a signed-in username, else "doctor" for the public HCP link.
  const user = (await currentUserId()) || (batchSurface === "doctor" ? "doctor" : "anon");

  let accepted = 0;
  for (const e of raw) {
    if (!e || typeof e.action !== "string" || typeof e.category !== "string") continue;
    const category = (CATEGORIES.has(e.category) ? e.category : "click") as ActivityCategory;
    const severity = (typeof e.severity === "string" && SEVERITIES.has(e.severity) ? e.severity : "info") as ActivitySeverity;
    recordActivity({
      user,
      surface: e.surface === "doctor" ? "doctor" : batchSurface,
      category,
      action: e.action,
      target: typeof e.target === "string" ? e.target : undefined,
      sessionId: typeof e.sessionId === "string" ? e.sessionId : undefined,
      severity,
      metadata: e.metadata && typeof e.metadata === "object" ? (e.metadata as Record<string, unknown>) : undefined,
      at: typeof e.at === "string" ? e.at : undefined,
    });
    accepted += 1;
  }
  return NextResponse.json({ ok: true, accepted });
}
