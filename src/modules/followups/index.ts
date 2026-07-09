/**
 * Follow-up tasks (brief §12). Lightweight. Created automatically from sessions
 * (human/MSL/AE requests). The brand user sees status only; CRM delivery is the
 * outbox's job (see @modules/crm).
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { newId, type FollowUpTaskId, type HcpId, type SessionId } from "@lib/ids";

export type FollowUpType = "human_rep" | "msl" | "medical_information" | "pharmacovigilance";

export type FollowUpStatus =
  | "created"
  | "sent_to_crm"
  | "failed"
  | "needs_mapping"
  | "retrying"
  | "completed"
  | "suppressed";

export interface FollowUpTask {
  id: FollowUpTaskId;
  hcpId: HcpId;
  type: FollowUpType;
  owner: string;
  status: FollowUpStatus;
  dueAt: string | null;
  sourceSessionId: SessionId;
}

export class FollowUpService {
  private readonly tasks: Repository<FollowUpTask>;
  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.tasks = repos.create<FollowUpTask>("followups");
  }

  async create(input: {
    hcpId: HcpId;
    type: FollowUpType;
    sourceSessionId: SessionId;
    owner?: string;
    dueAt?: string | null;
    seed?: string;
  }): Promise<FollowUpTask> {
    return this.tasks.insert({
      id: newId<"follow_up_task_id">("fu", input.seed) as FollowUpTaskId,
      hcpId: input.hcpId,
      type: input.type,
      owner: input.owner ?? defaultOwner(input.type),
      status: "created",
      dueAt: input.dueAt ?? null,
      sourceSessionId: input.sourceSessionId,
    });
  }

  async setStatus(id: FollowUpTaskId, status: FollowUpStatus): Promise<FollowUpTask | null> {
    return this.tasks.update(id, { status });
  }

  async list(): Promise<FollowUpTask[]> {
    return this.tasks.list();
  }
}

function defaultOwner(type: FollowUpType): string {
  switch (type) {
    case "msl":
    case "medical_information":
      return "Medical Information";
    case "pharmacovigilance":
      return "Pharmacovigilance";
    case "human_rep":
      return "Field Rep";
  }
}
