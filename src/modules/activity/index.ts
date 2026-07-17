/**
 * Activity log — a process-global, capped, chronological record of EVERYTHING that happens in the
 * app (every click, navigation, API call, upload, update, connection, session/video lifecycle,
 * compliance decision, recording, CRM, follow-up), so an operator can watch what any user did/does
 * from the in-app Admin → Activity dashboard WITHOUT tailing the host console.
 *
 * Deliberately CROSS-USER, unlike the per-user `audit` store (which is per-session, has no timestamp
 * and no user attribution): this is the platform-admin observability feed, so it stamps the acting
 * user and a wall-clock time on every event and lives in ONE global buffer.
 *
 * In-memory + capped for now (resets on restart — consistent with the rest of the stateless demo),
 * but behind this small module surface so a durable store (Postgres) can replace the buffer later
 * without touching a single caller or the UI. Single-instance deploy (render numInstances:1) → one
 * shared log across every request.
 */

export type ActivitySeverity = "info" | "notice" | "warn" | "error";

/** Coarse buckets the dashboard colours + filters by. Keep in sync with ACTIVITY_CATEGORIES. */
export type ActivityCategory =
  | "auth"
  | "navigation"
  | "click"
  | "api"
  | "content"
  | "training"
  | "audience"
  | "launch"
  | "session"
  | "video"
  | "compliance"
  | "recording"
  | "followup"
  | "crm"
  | "system";

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "auth", "navigation", "click", "api", "content", "training", "audience",
  "launch", "session", "video", "compliance", "recording", "followup", "crm", "system",
];

export interface ActivityEvent {
  id: string;
  /** Monotonic sequence — stable ordering AND the cursor the dashboard polls with (sinceSeq). */
  seq: number;
  /** ISO wall-clock timestamp. */
  at: string;
  /** The acting user: a signed-in username, or "doctor" (public HCP link) / "anon" / "system". */
  user: string;
  /** Where it originated. */
  surface: "brand" | "doctor" | "server";
  category: ActivityCategory;
  /** Short human phrase, e.g. "Uploaded content", "Clicked", "GET /api/sessions", "Launched". */
  action: string;
  /** What was acted on (file name, session id, path, button label…). */
  target?: string;
  /** The session this relates to, when applicable (links the feed to Session review). */
  sessionId?: string;
  severity: ActivitySeverity;
  /** Small, JSON-serializable extra detail rendered as clean key/values in the UI. */
  metadata?: Record<string, unknown>;
}

export interface ActivityInput {
  user?: string;
  surface?: ActivityEvent["surface"];
  category: ActivityCategory;
  action: string;
  target?: string;
  sessionId?: string;
  severity?: ActivitySeverity;
  metadata?: Record<string, unknown>;
  at?: string;
}

const MAX_EVENTS = 5000; // bound memory; oldest fall off (the dashboard is live monitoring, not archival)

// Process-global so every route in this (single) instance shares ONE log, independent of the
// per-user container isolation (the admin view is intentionally cross-user).
const g = globalThis as unknown as { __nexusrepActivity?: { events: ActivityEvent[]; seq: number } };
function store(): { events: ActivityEvent[]; seq: number } {
  if (!g.__nexusrepActivity) g.__nexusrepActivity = { events: [], seq: 0 };
  return g.__nexusrepActivity;
}

function clampMeta(m: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const json = JSON.stringify(m);
    if (json.length <= 4000) return m;
    return { note: "metadata truncated for the activity log", size: json.length };
  } catch {
    return { note: "unserializable metadata" };
  }
}

/** Record one event. Synchronous, never throws to the caller (observability must not break flows). */
export function recordActivity(input: ActivityInput): ActivityEvent | null {
  try {
    const s = store();
    const seq = ++s.seq;
    const ev: ActivityEvent = {
      id: `act_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      seq,
      at: input.at ?? new Date().toISOString(),
      user: input.user?.toString().trim() || "anon",
      surface: input.surface ?? "server",
      category: input.category,
      action: String(input.action).slice(0, 200),
      ...(input.target ? { target: String(input.target).slice(0, 300) } : {}),
      ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
      severity: input.severity ?? "info",
      ...(input.metadata ? { metadata: clampMeta(input.metadata) } : {}),
    };
    s.events.push(ev);
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    return ev;
  } catch {
    return null;
  }
}

export interface ActivityQuery {
  user?: string;
  category?: string;
  surface?: string;
  severity?: string;
  sessionId?: string;
  q?: string;
  /** Poll cursor: only return events with seq strictly greater than this (incremental live update). */
  sinceSeq?: number;
  limit?: number;
}

export interface ActivitySummary {
  /** Total events currently retained (across ALL users), not just the filtered slice. */
  total: number;
  /** How many match the current filter. */
  shown: number;
  byCategory: Record<string, number>;
  byUser: Record<string, number>;
  errors: number;
  /** Distinct users + categories seen (for building filter dropdowns). */
  users: string[];
  categories: string[];
  /** The newest seq — the dashboard passes this back as sinceSeq to fetch only what's new. */
  latestSeq: number;
}

export function queryActivity(f: ActivityQuery = {}): { events: ActivityEvent[]; summary: ActivitySummary } {
  const all = store().events;
  const needle = f.q?.toLowerCase().trim();
  const matches = (e: ActivityEvent): boolean =>
    (!f.user || e.user === f.user) &&
    (!f.category || e.category === f.category) &&
    (!f.surface || e.surface === f.surface) &&
    (!f.severity || e.severity === f.severity) &&
    (!f.sessionId || e.sessionId === f.sessionId) &&
    (f.sinceSeq == null || e.seq > f.sinceSeq) &&
    (!needle ||
      `${e.action} ${e.target ?? ""} ${e.user} ${e.category} ${e.surface} ${e.metadata ? JSON.stringify(e.metadata) : ""}`
        .toLowerCase()
        .includes(needle));

  const filtered = all.filter(matches);
  const limit = Math.min(Math.max(f.limit ?? 250, 1), 1000);
  const events = filtered.slice(-limit).reverse(); // newest first, capped

  const byCategory: Record<string, number> = {};
  const byUser: Record<string, number> = {};
  let errors = 0;
  for (const e of all) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byUser[e.user] = (byUser[e.user] ?? 0) + 1;
    if (e.severity === "error") errors += 1;
  }

  return {
    events,
    summary: {
      total: all.length,
      shown: filtered.length,
      byCategory,
      byUser,
      errors,
      users: Object.keys(byUser).sort(),
      categories: Object.keys(byCategory).sort(),
      latestSeq: all.length ? all[all.length - 1]!.seq : 0,
    },
  };
}

/** Reset the log — tests only (and a possible admin "clear" button later). */
export function clearActivity(): void {
  const s = store();
  s.events = [];
  s.seq = 0;
}
