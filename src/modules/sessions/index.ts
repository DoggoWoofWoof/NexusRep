/**
 * Conversation sessions & turns (brief §10, §16). A session is the unit reviewed
 * in Sessions and trained-from in Improve. Compliance status is explicit — never
 * a vague "Clean" (brief §10) — and is derived from the actual per-turn routing
 * and gate decisions, not asserted by hand.
 *
 * Repo-backed and Postgres-ready: the service depends only on Repository<T>.
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { newId, type AiRepId, type HcpId, type SessionId, type TurnId } from "@lib/ids";
import type { PolicyRoute } from "@modules/compliance";

export type SessionComplianceStatus =
  | "approved"
  | "needs_review"
  | "ae_routed"
  | "blocked_escalated";

export interface ConversationTurn {
  id: TurnId;
  sessionId: SessionId;
  speaker: "hcp" | "rep";
  text: string;
  /** Approved-answer IDs used to compose a rep turn. */
  sourceIds: string[];
  /** Detail-aid slide the rep showed for this turn (drives the replay's slide, no
   *  keyword guessing). Set on rep turns that surfaced a slide. */
  detailAidSlideId?: string;
  /** ISO timestamp when the turn was logged (drives the click-through transcript). */
  at?: string;
}

export interface ConversationSession {
  id: SessionId;
  aiRepId: AiRepId;
  hcpId: HcpId;
  startedAt: string;
  durationSeconds: number;
  questionCount: number;
  complianceStatus: SessionComplianceStatus;
  turns: ConversationTurn[];
  /** Tavus conversation id backing this session (for recording callbacks). */
  tavusConversationId?: string;
  /** Playback recording URL once Tavus's recording_ready callback lands. */
  recordingUrl?: string;
}

/** Severity ordering so a session's status reflects its worst turn. */
const SEVERITY: Record<SessionComplianceStatus, number> = {
  approved: 0,
  needs_review: 1,
  ae_routed: 2,
  blocked_escalated: 3,
};

/** Map one turn's route + gate decision to the compliance status it implies. */
export function outcomeToStatus(outcome: { route: PolicyRoute; decision: "approved" | "blocked" }): SessionComplianceStatus {
  if (outcome.decision === "blocked") return "blocked_escalated";
  if (outcome.route === "adverse_event") return "ae_routed";
  if (
    outcome.route === "off_label_refusal" ||
    outcome.route === "medical_information" ||
    outcome.route === "human_handoff" ||
    outcome.route === "fallback"
  ) {
    return "needs_review";
  }
  return "approved";
}

function worse(a: SessionComplianceStatus, b: SessionComplianceStatus): SessionComplianceStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export function sessionTranscriptSpanSeconds(session: Pick<ConversationSession, "startedAt" | "turns">): number {
  const times = session.turns
    .map((turn) => (turn.at ? Date.parse(turn.at) : NaN))
    .filter(Number.isFinite);
  if (times.length >= 2) {
    return Math.max(0, Math.round((Math.max(...times) - Math.min(...times)) / 1000));
  }
  if (times.length === 1) {
    return Math.max(0, Math.round((times[0]! - Date.parse(session.startedAt)) / 1000));
  }
  return 0;
}

export function deriveSessionDurationSeconds(session: ConversationSession): number {
  return Math.max(0, session.durationSeconds, sessionTranscriptSpanSeconds(session));
}

export class SessionService {
  private readonly sessions: Repository<ConversationSession>;
  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.sessions = repos.create<ConversationSession>("sessions");
  }

  /** Open a session. `startedAt`/`seed` are injectable so tests stay deterministic. */
  async start(input: { aiRepId: AiRepId; hcpId: HcpId; startedAt?: string; seed?: string }): Promise<ConversationSession> {
    return this.sessions.insert({
      id: newId<"session_id">("session", input.seed) as SessionId,
      aiRepId: input.aiRepId,
      hcpId: input.hcpId,
      startedAt: input.startedAt ?? new Date().toISOString(),
      durationSeconds: 0,
      questionCount: 0,
      complianceStatus: "approved",
      turns: [],
    });
  }

  async appendTurn(
    sessionId: SessionId,
    input: { speaker: "hcp" | "rep"; text: string; sourceIds?: string[]; detailAidSlideId?: string; seed?: string; at?: string },
  ): Promise<ConversationSession | null> {
    const s = await this.sessions.get(sessionId);
    if (!s) return null;
    const turn: ConversationTurn = {
      id: newId<"turn_id">("turn", input.seed) as TurnId,
      sessionId,
      speaker: input.speaker,
      text: input.text,
      sourceIds: input.sourceIds ?? [],
      ...(input.detailAidSlideId ? { detailAidSlideId: input.detailAidSlideId } : {}),
      at: input.at ?? new Date().toISOString(),
    };
    const turns = [...s.turns, turn];
    const questionCount = turns.filter((t) => t.speaker === "hcp").length;
    return this.sessions.update(sessionId, { turns, questionCount });
  }

  /** Fold a turn's routing/gate result into the session's running compliance status. */
  async recordOutcome(
    sessionId: SessionId,
    outcome: { route: PolicyRoute; decision: "approved" | "blocked" },
  ): Promise<ConversationSession | null> {
    const s = await this.sessions.get(sessionId);
    if (!s) return null;
    return this.sessions.update(sessionId, {
      complianceStatus: worse(s.complianceStatus, outcomeToStatus(outcome)),
    });
  }

  /** Finalize duration. Either pass explicit seconds or an endedAt to diff. */
  async end(sessionId: SessionId, input?: { durationSeconds?: number; endedAt?: string }): Promise<ConversationSession | null> {
    const s = await this.sessions.get(sessionId);
    if (!s) return null;
    let durationSeconds = input?.durationSeconds;
    if (durationSeconds == null && input?.endedAt) {
      durationSeconds = Math.max(0, Math.round((Date.parse(input.endedAt) - Date.parse(s.startedAt)) / 1000));
    }
    return this.sessions.update(sessionId, { durationSeconds: durationSeconds ?? s.durationSeconds });
  }

  /** Link the Tavus conversation so its recording callback can find this session. */
  async setTavusConversation(sessionId: SessionId, tavusConversationId: string): Promise<ConversationSession | null> {
    return this.sessions.update(sessionId, { tavusConversationId });
  }

  /** Attach a playback recording URL, keyed by the Tavus conversation id. */
  async attachRecording(tavusConversationId: string, recordingUrl: string): Promise<ConversationSession | null> {
    const [match] = await this.sessions.list({ where: { tavusConversationId } });
    if (!match) return null;
    return this.sessions.update(match.id, { recordingUrl });
  }

  async get(sessionId: SessionId): Promise<ConversationSession | null> {
    return this.sessions.get(sessionId);
  }

  /** All sessions, newest first. */
  async list(): Promise<ConversationSession[]> {
    const rows = await this.sessions.list();
    return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  /** Insert a fully-formed session (used to seed realistic demo history). */
  async seed(session: ConversationSession): Promise<ConversationSession> {
    return this.sessions.insert(session);
  }
}
