/**
 * CRM event service (brief §8, §12; PDF §6 outbox, §9 canonical event).
 *
 * CRM is automated backend handoff, never a manual UI tab. Events are written to
 * an outbox first, then delivered asynchronously through a swappable CrmAdapter
 * with retry + status tracking. The UI only ever sees a status, never JSON.
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { newId, type CrmEventId, type SessionId } from "@lib/ids";
import {
  type CrmAdapter,
  type CrmDeliveryStatus,
  type CrmEventPayload,
} from "@modules/vendors";

export interface OutboxEntry {
  id: CrmEventId;
  sessionId: SessionId;
  status: CrmDeliveryStatus;
  attempts: number;
  payload: CrmEventPayload;
  lastDetail?: string;
  /** Earliest epoch-ms a retry should be attempted — set by deliver() as exponential backoff so the
   *  scheduled flush doesn't hammer a failing endpoint. */
  nextAttemptAt?: number;
}

// A permanently-failing / unmappable entry must NOT be retried forever once flush() is scheduled.
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const TERMINAL: readonly CrmDeliveryStatus[] = ["sent", "suppressed"];

export class CrmOutbox {
  private readonly entries: Repository<OutboxEntry>;

  constructor(private readonly adapter: CrmAdapter, repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.entries = repos.create<OutboxEntry>("crm_outbox");
  }

  /** The configured adapter's name — surfaced in the UI so a mock is labeled as one,
   *  never masquerading as a specific vendor ("Veeva") that isn't actually connected. */
  get adapterName(): string {
    return this.adapter.name;
  }

  /** Enqueue a CRM-ready event. Always starts as "created". */
  async enqueue(
    sessionId: SessionId,
    payload: CrmEventPayload,
    seed?: string,
  ): Promise<OutboxEntry> {
    return this.entries.insert({
      id: newId<"crm_event_id">("crm", seed) as CrmEventId,
      sessionId,
      status: "created",
      attempts: 0,
      payload,
    });
  }

  /** Deliver one entry through the adapter, recording the resulting status. On a non-terminal result
   *  (failed/retrying/needs_mapping) it sets an exponential backoff so a scheduled flush waits before
   *  the next attempt. */
  async deliver(id: CrmEventId, now: number = Date.now()): Promise<OutboxEntry | null> {
    const entry = await this.entries.get(id);
    if (!entry) return null;
    const result = await this.adapter.deliver(entry.payload);
    const attempts = entry.attempts + 1;
    const patch: Partial<OutboxEntry> = { status: result.status, attempts, lastDetail: result.detail };
    if (!TERMINAL.includes(result.status)) {
      patch.nextAttemptAt = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 20));
    }
    return this.entries.update(id, patch);
  }

  /**
   * Retry every non-terminal entry whose backoff has elapsed. Two safeguards make this safe to run on a
   * timer: entries past MAX_ATTEMPTS are SUPPRESSED (terminal) instead of retried forever, and each
   * retry honors the per-entry backoff set by deliver(). Sequential per outbox (one CRM at a time).
   */
  async flush(now: number = Date.now()): Promise<OutboxEntry[]> {
    const all = await this.entries.list();
    const out: OutboxEntry[] = [];
    for (const e of all) {
      if (TERMINAL.includes(e.status)) continue;
      if (e.attempts >= MAX_ATTEMPTS) {
        const updated = await this.entries.update(e.id, {
          status: "suppressed",
          lastDetail: `gave up after ${e.attempts} attempts${e.lastDetail ? `: ${e.lastDetail}` : ""}`,
        });
        if (updated) out.push(updated);
        continue;
      }
      if (e.nextAttemptAt != null && e.nextAttemptAt > now) continue; // backoff not elapsed
      const updated = await this.deliver(e.id, now);
      if (updated) out.push(updated);
    }
    return out;
  }

  async list(): Promise<OutboxEntry[]> {
    return this.entries.list();
  }
}
