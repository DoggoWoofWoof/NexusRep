/**
 * Audit service (brief §11; PDF §11 "immutable audit"). Append-only event log
 * that proves what happened on every turn: classification, retrieval, source
 * validation, compliance decision, output, escalation, CRM event. Corrections
 * are appended as correction events, never destructive edits.
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { newId, type AuditEventId, type SessionId, type TurnId } from "@lib/ids";

export type AuditEventType =
  | "content_removed"
  | "classification"
  | "retrieval"
  | "source_validation"
  | "response_validation"
  | "compliance_decision"
  | "response_output"
  | "escalation"
  | "follow_up_created"
  | "crm_event"
  | "coaching_rule_applied"
  | "correction";

export interface AuditRecord {
  id: AuditEventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: AuditEventType;
  /** Monotonic sequence for deterministic ordering (set by the service). */
  seq: number;
  payload: Record<string, unknown>;
}

export class AuditService {
  private readonly log: Repository<AuditRecord>;
  private seq = 0;
  /** seq must continue from the DURABLE store's max — a restart used to reset it to 0,
   *  interleaving new events with old ones when forSession sorts by seq. */
  private seqSeeded: Promise<void> | null = null;

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.log = repos.createAppendOnly<AuditRecord>("audit");
  }

  private ensureSeq(): Promise<void> {
    if (!this.seqSeeded) {
      this.seqSeeded = this.log
        .list()
        .then((rows) => {
          for (const r of rows) if (typeof r.seq === "number" && r.seq >= this.seq) this.seq = r.seq + 1;
        })
        .catch(() => undefined); // empty/new store — start at 0
    }
    return this.seqSeeded;
  }

  async record(
    sessionId: SessionId,
    type: AuditEventType,
    payload: Record<string, unknown>,
    turnId?: TurnId,
    seed?: string,
  ): Promise<AuditRecord> {
    await this.ensureSeq();
    const rec: AuditRecord = {
      id: newId<"audit_event_id">("aud", seed) as AuditEventId,
      sessionId,
      turnId,
      type,
      seq: this.seq++,
      payload,
    };
    return this.log.insert(rec);
  }

  async forSession(sessionId: SessionId): Promise<AuditRecord[]> {
    const rows = await this.log.list({ where: { sessionId } });
    return rows.sort((a, b) => a.seq - b.seq);
  }

  /** All events of one type across every session — the source for aggregate analytics
   *  (topic distribution from "classification", measured compliance from
   *  "compliance_decision") instead of hardcoded illustrative numbers. */
  async allOfType(type: AuditEventType): Promise<AuditRecord[]> {
    return this.log.list({ where: { type } });
  }
}
