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
}

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

  /** Deliver one entry through the adapter, recording the resulting status. */
  async deliver(id: CrmEventId): Promise<OutboxEntry | null> {
    const entry = await this.entries.get(id);
    if (!entry) return null;
    const result = await this.adapter.deliver(entry.payload);
    return this.entries.update(id, {
      status: result.status,
      attempts: entry.attempts + 1,
      lastDetail: result.detail,
    });
  }

  /** Retry every entry that is not in a terminal-success/suppressed state. */
  async flush(): Promise<OutboxEntry[]> {
    const all = await this.entries.list();
    const pending = all.filter((e) => !["sent", "suppressed"].includes(e.status));
    const out: OutboxEntry[] = [];
    for (const e of pending) {
      const updated = await this.deliver(e.id);
      if (updated) out.push(updated);
    }
    return out;
  }

  async list(): Promise<OutboxEntry[]> {
    return this.entries.list();
  }
}
