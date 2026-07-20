/**
 * Per-HCP cross-session memory — "context and memory per HCP on our side, not relying on Tavus"
 * (recreating what a vendor conversation store might hold, but ours). After a session ends we distill
 * an HCP-LEVEL, aggregate, NON-PII record of what happened — which approved TOPICS were covered, which
 * intents were asked, the route outcomes, and whether a human or an adverse event was ever raised — and
 * fold it into a rolling memory for that HCP. That memory is then:
 *   1) injected as advisory CONTINUITY context into the HCP's NEXT session (so the AI can pick up where
 *      it left off instead of re-explaining the basics), and
 *   2) attached to FOLLOW-UPS (so the next human touch is informed by the prior conversation).
 *
 * Hard rule (CLAUDE.md): raw patient-level detail never enters this record. We store approved-topic
 * LABELS + counts + coarse flags only — HCP-level aggregate features, nothing patient-specific. The
 * continuity context is advisory: the compliance gate + grounding still decide every live answer.
 *
 * Repo-backed and Postgres-ready (one record per HCP, keyed by hcpId).
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import type { HcpId, SessionId } from "@lib/ids";

export interface HcpTopicStat {
  topic: string;
  count: number;
  lastAt: string;
}

export interface HcpMemory {
  /** Keyed by hcpId — one rolling memory per HCP (natural upsert). */
  id: string;
  hcpId: HcpId;
  updatedAt: string;
  /** Sessions already folded in — the set is what makes recordSession idempotent (no double counting
   *  if a session is distilled twice) and is the source of the session count. */
  sessionIds: string[];
  lastSessionId: SessionId;
  lastSessionAt: string;
  /** Approved-topic labels covered with this HCP, most-discussed first. Safe to inject/show. */
  topics: HcpTopicStat[];
  intents: { intent: string; count: number }[];
  routes: { route: string; count: number }[];
  everRequestedHuman: boolean;
  everReportedAe: boolean;
  /** One short, human-readable line safe to inject into a prompt or show in the console. */
  recap: string;
}

/** The distilled, non-PII facts of ONE finished session. */
export interface SessionFacts {
  sessionId: SessionId;
  hcpId: HcpId;
  at: string;
  topics: string[];
  intents: string[];
  routes: string[];
  requestedHuman: boolean;
  reportedAe: boolean;
}

// Minimal structural shapes so this module doesn't couple to the sessions/audit concrete types.
interface DistillableTurn {
  speaker: "hcp" | "rep";
  sourceIds?: string[];
}
interface DistillableSession {
  id: SessionId;
  hcpId: HcpId;
  startedAt: string;
  turns: DistillableTurn[];
}
interface DistillableAudit {
  type: string;
  payload: Record<string, unknown>;
}

const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

/**
 * Distill one finished session into non-PII facts. Topics come from the approved-answer ids the rep
 * actually served (turn sourceIds + response_output sourceIds), resolved to their topic LABELS via the
 * injected resolver — never from raw HCP text, so nothing patient-specific is captured.
 */
export async function distillSession(
  session: DistillableSession,
  auditEvents: DistillableAudit[],
  resolveTopic: (sourceId: string) => Promise<string | undefined>,
): Promise<SessionFacts> {
  const ids = new Set<string>();
  for (const t of session.turns) for (const id of t.sourceIds ?? []) ids.add(id);
  for (const e of auditEvents) {
    if (e.type === "response_output" && Array.isArray(e.payload.sourceIds)) {
      for (const id of e.payload.sourceIds as string[]) ids.add(id);
    }
  }
  const topics: string[] = [];
  for (const id of ids) {
    const topic = await resolveTopic(id).catch(() => undefined);
    if (topic) topics.push(topic);
  }
  const intents = auditEvents
    .filter((e) => e.type === "classification" && typeof e.payload.intent === "string")
    .map((e) => e.payload.intent as string);
  const routes = auditEvents
    .filter((e) => e.type === "response_output" && typeof e.payload.route === "string")
    .map((e) => e.payload.route as string);
  const followTypes = auditEvents
    .filter((e) => e.type === "follow_up_created" && typeof e.payload.type === "string")
    .map((e) => e.payload.type as string);
  const requestedHuman = routes.includes("human_handoff") || followTypes.includes("human_rep");
  const reportedAe = routes.includes("adverse_event") || followTypes.includes("pharmacovigilance");
  return {
    sessionId: session.id,
    hcpId: session.hcpId,
    at: session.startedAt,
    topics: uniq(topics),
    intents: uniq(intents),
    routes: uniq(routes),
    requestedHuman,
    reportedAe,
  };
}

function bump<T extends { count: number }>(list: T[], key: keyof T, value: string, extra?: (row: T) => void): T[] {
  const row = list.find((r) => (r[key] as unknown as string) === value);
  if (row) {
    row.count += 1;
    extra?.(row);
    return list;
  }
  const created = { [key]: value, count: 1 } as unknown as T;
  extra?.(created);
  return [...list, created];
}

/** One short line, safe to inject into a prompt and to show in the console. Topic labels only. */
export function buildRecap(m: Pick<HcpMemory, "sessionIds" | "lastSessionAt" | "topics" | "everRequestedHuman" | "everReportedAe">): string {
  const n = m.sessionIds.length;
  if (n === 0) return "";
  const when = m.lastSessionAt ? m.lastSessionAt.slice(0, 10) : "";
  const top = [...m.topics].sort((a, b) => b.count - a.count || (a.topic < b.topic ? -1 : 1)).slice(0, 3).map((t) => t.topic);
  const parts = [`${n} prior session${n > 1 ? "s" : ""}${when ? ` (last ${when})` : ""}.`];
  if (top.length) parts.push(`Previously covered: ${top.join(", ")}.`);
  if (m.everRequestedHuman) parts.push("Has asked for a human rep before.");
  if (m.everReportedAe) parts.push("A possible adverse event was raised in a prior session.");
  return parts.join(" ");
}

/**
 * Fold one session's facts into the HCP's rolling memory. Pure + idempotent: a session already folded
 * (by id) is a no-op, so distilling the same session twice can't double-count. Ordering-robust: the
 * "last session" fields only advance to a strictly newer timestamp.
 */
export function foldMemory(existing: HcpMemory | null, facts: SessionFacts, now: string): HcpMemory {
  const base: HcpMemory = existing ?? {
    id: String(facts.hcpId),
    hcpId: facts.hcpId,
    updatedAt: now,
    sessionIds: [],
    lastSessionId: facts.sessionId,
    lastSessionAt: facts.at,
    topics: [],
    intents: [],
    routes: [],
    everRequestedHuman: false,
    everReportedAe: false,
    recap: "",
  };
  if (base.sessionIds.includes(String(facts.sessionId))) return base; // idempotent

  let topics = base.topics.map((t) => ({ ...t }));
  for (const topic of facts.topics) {
    topics = bump(topics, "topic", topic, (row) => {
      (row as HcpTopicStat).lastAt = facts.at;
    });
  }
  let intents = base.intents.map((i) => ({ ...i }));
  for (const intent of facts.intents) intents = bump(intents, "intent", intent);
  let routes = base.routes.map((r) => ({ ...r }));
  for (const route of facts.routes) routes = bump(routes, "route", route);

  const isNewer = !base.sessionIds.length || facts.at >= base.lastSessionAt;
  const folded: HcpMemory = {
    ...base,
    updatedAt: now,
    sessionIds: [...base.sessionIds, String(facts.sessionId)],
    lastSessionId: isNewer ? facts.sessionId : base.lastSessionId,
    lastSessionAt: isNewer ? facts.at : base.lastSessionAt,
    topics: topics.sort((a, b) => b.count - a.count || (a.topic < b.topic ? -1 : 1)),
    intents: intents.sort((a, b) => b.count - a.count),
    routes: routes.sort((a, b) => b.count - a.count),
    everRequestedHuman: base.everRequestedHuman || facts.requestedHuman,
    everReportedAe: base.everReportedAe || facts.reportedAe,
  };
  folded.recap = buildRecap(folded);
  return folded;
}

export class HcpMemoryService {
  private readonly memories: Repository<HcpMemory>;

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.memories = repos.create<HcpMemory>("hcp_memory");
  }

  async get(hcpId: HcpId): Promise<HcpMemory | null> {
    return this.memories.get(String(hcpId));
  }

  async list(): Promise<HcpMemory[]> {
    return this.memories.list();
  }

  /** Fold a finished session's distilled facts into the HCP's rolling memory (upsert, idempotent). */
  async recordSession(facts: SessionFacts): Promise<HcpMemory> {
    const existing = await this.memories.get(String(facts.hcpId));
    const folded = foldMemory(existing, facts, new Date().toISOString());
    if (!existing) return this.memories.insert(folded);
    return (await this.memories.update(String(facts.hcpId), folded)) ?? folded;
  }
}
