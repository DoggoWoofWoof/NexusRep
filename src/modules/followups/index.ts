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
  /** Optional per-type owner resolution — wired by the container to the brand user's
   *  Setup Assistant answers (msl_contact / ae_routing), so the configured contacts
   *  actually OWN the follow-ups instead of generic labels. */
  private readonly ownerFor?: (type: FollowUpType) => Promise<string | undefined>;

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory(), ownerFor?: (type: FollowUpType) => Promise<string | undefined>) {
    this.tasks = repos.create<FollowUpTask>("followups");
    this.ownerFor = ownerFor;
  }

  async create(input: {
    hcpId: HcpId;
    type: FollowUpType;
    sourceSessionId: SessionId;
    owner?: string;
    dueAt?: string | null;
    seed?: string;
  }): Promise<FollowUpTask> {
    const configured = input.owner ?? (await this.ownerFor?.(input.type).catch(() => undefined));
    return this.tasks.insert({
      id: newId<"follow_up_task_id">("fu", input.seed) as FollowUpTaskId,
      hcpId: input.hcpId,
      type: input.type,
      owner: configured ?? defaultOwner(input.type),
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
