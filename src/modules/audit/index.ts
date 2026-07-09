/**
 * Audit service (brief §11; PDF §11 "immutable audit"). Append-only event log
 * that proves what happened on every turn: classification, retrieval, source
 * validation, compliance decision, output, escalation, CRM event. Corrections
 * are appended as correction events, never destructive edits.
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { newId, type AuditEventId, type SessionId, type TurnId } from "@lib/ids";

export type AuditEventType =
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

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.log = repos.createAppendOnly<AuditRecord>("audit");
  }

  async record(
    sessionId: SessionId,
    type: AuditEventType,
    payload: Record<string, unknown>,
    turnId?: TurnId,
    seed?: string,
  ): Promise<AuditRecord> {
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
}
