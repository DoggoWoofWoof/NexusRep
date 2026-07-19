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
  /** The realtime vendor's conversation id for this call (whichever provider ran it). */
  vendorConversationId?: string;
  /** WHY the call ended — a normalized reason so Session review + the admin activity feed can tell a
   *  deliberate "End" from a timeout/disconnect/max-duration. First meaningful reason wins. */
  endReason?: string;
  /** Playback recording URL once Tavus's recording_ready callback lands. */
  recordingUrl?: string;
  /** Length of the captured recording in ms (client MediaRecorder clock). Lets Session review detect
   *  a recording that ends before the transcript did (video switched off early / truncated). */
  recordingDurationMs?: number;
  /** Review timeline source. "recorded" means turn.at is already synced to the playback recording. */
  timelineSource?: "recorded";
  /** True when this is a BRAND-USER PREVIEW (opened /hcp to try the rep) rather than a real invited
   *  HCP. Drives the "Preview" label (never a doctor's name) and lets stray empty previews be pruned. */
  preview?: boolean;
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
  /** Per-session write chains. appendTurn/recordOutcome are read-modify-write, so two
   *  concurrent turns (e.g. a Tavus HCP utterance + the rep reply) could read the same
   *  state and silently drop one. Serializing per session id makes writes atomic
   *  within this process. */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.sessions = repos.create<ConversationSession>("sessions");
  }

  private serialize<T>(sessionId: SessionId, op: () => Promise<T>): Promise<T> {
    const key = String(sessionId);
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const next = prev.then(op, op); // run even if the prior op failed
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, tail);
    void tail.then(() => {
      if (this.writeChains.get(key) === tail) this.writeChains.delete(key);
    });
    return next;
  }

  /** Open a session. `startedAt`/`seed` are injectable so tests stay deterministic. */
  async start(input: { aiRepId: AiRepId; hcpId: HcpId; startedAt?: string; seed?: string; preview?: boolean }): Promise<ConversationSession> {
    return this.sessions.insert({
      id: newId<"session_id">("session", input.seed) as SessionId,
      aiRepId: input.aiRepId,
      hcpId: input.hcpId,
      startedAt: input.startedAt ?? new Date().toISOString(),
      durationSeconds: 0,
      questionCount: 0,
      complianceStatus: "approved",
      turns: [],
      ...(input.preview ? { preview: true } : {}),
    });
  }

  /**
   * Delete STRAY preview sessions: a brand-user preview that produced NO recording and NO real Q&A
   * (just the greeting). NEVER removes a session with a recording, real questions, the live call, or
   * one still recent (may be in use in another tab) — `endedSessionId` is the one the caller just
   * ended, eligible even if recent because the user ended it. Returns the ids removed.
   */
  async pruneStrayPreviews(opts: { activeSessionId?: string | null; endedSessionId?: string | null; graceMs?: number } = {}): Promise<string[]> {
    const grace = opts.graceMs ?? 10 * 60_000;
    const now = Date.now();
    const removed: string[] = [];
    for (const s of await this.sessions.list()) {
      if (!s.preview || s.recordingUrl || s.questionCount > 0) continue; // keep recorded / real-Q&A / non-preview
      if (String(s.id) === String(opts.activeSessionId ?? "")) continue; // never the live call
      const startedMs = Date.parse(s.startedAt);
      const recent = Number.isFinite(startedMs) && now - startedMs < grace;
      if (recent && String(s.id) !== String(opts.endedSessionId ?? "")) continue; // spare a possibly in-use recent one
      if (await this.sessions.delete(String(s.id))) removed.push(String(s.id));
    }
    return removed;
  }

  async appendTurn(
    sessionId: SessionId,
    input: { speaker: "hcp" | "rep"; text: string; sourceIds?: string[]; detailAidSlideId?: string; seed?: string; at?: string },
  ): Promise<ConversationSession | null> {
    return this.serialize(sessionId, async () => {
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
    });
  }

  async removeRecentTurn(
    sessionId: SessionId,
    input: { speaker: "hcp" | "rep"; text: string; withinMs?: number },
  ): Promise<{ session: ConversationSession | null; removed: boolean }> {
    return this.serialize(sessionId, async () => {
      const s = await this.sessions.get(sessionId);
      if (!s) return { session: null, removed: false };
      const target = input.text.replace(/\s+/g, " ").trim();
      const withinMs = input.withinMs ?? 45_000;
      const now = Date.now();
      const index = (() => {
        for (let i = s.turns.length - 1; i >= 0; i--) {
          const turn = s.turns[i]!;
          if (turn.speaker !== input.speaker) continue;
          if (turn.text.replace(/\s+/g, " ").trim() !== target) continue;
          if (turn.at && Number.isFinite(Date.parse(turn.at)) && now - Date.parse(turn.at) > withinMs) continue;
          return i;
        }
        return -1;
      })();
      if (index < 0) return { session: s, removed: false };
      const turns = s.turns.filter((_, i) => i !== index);
      const questionCount = turns.filter((t) => t.speaker === "hcp").length;
      const updated = await this.sessions.update(sessionId, { turns, questionCount });
      return { session: updated, removed: true };
    });
  }

  /** Fold a turn's routing/gate result into the session's running compliance status. */
  async recordOutcome(
    sessionId: SessionId,
    outcome: { route: PolicyRoute; decision: "approved" | "blocked" },
  ): Promise<ConversationSession | null> {
    return this.serialize(sessionId, async () => {
      const s = await this.sessions.get(sessionId);
      if (!s) return null;
      return this.sessions.update(sessionId, {
        complianceStatus: worse(s.complianceStatus, outcomeToStatus(outcome)),
      });
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
  async setVendorConversation(sessionId: SessionId, vendorConversationId: string): Promise<ConversationSession | null> {
    return this.sessions.update(sessionId, { vendorConversationId });
  }

  /** Find the session linked to a Tavus conversation id (reverse of setVendorConversation). */
  async getByVendorConversation(vendorConversationId: string): Promise<ConversationSession | null> {
    if (!vendorConversationId) return null;
    const [match] = await this.sessions.list({ where: { vendorConversationId } });
    return match ?? null;
  }

  /** Attach a playback recording URL, keyed by the Tavus conversation id. */
  async attachRecording(vendorConversationId: string, recordingUrl: string): Promise<ConversationSession | null> {
    const match = await this.getByVendorConversation(vendorConversationId);
    if (!match) return null;
    return this.sessions.update(match.id, { recordingUrl });
  }

  /** Record WHY the call ended, keyed by the Tavus conversation id. First meaningful reason wins — a
   *  deliberate "End" recorded by the client shouldn't be overwritten by a later Tavus timeout sweep. */
  async setEndReason(vendorConversationId: string, endReason: string): Promise<ConversationSession | null> {
    const match = await this.getByVendorConversation(vendorConversationId);
    if (!match) return null;
    if (match.endReason) return match; // don't clobber an already-recorded reason
    return this.sessions.update(match.id, { endReason });
  }

  /** Attach a playback recording URL directly by session id — used by the client-side capture
   *  upload (the browser knows its own session id), independent of any vendor conversation id.
   *  durationMs (from the client's MediaRecorder clock) lets Session review tell an HONEST story when
   *  the recording is shorter than the transcript (video switched off early / clip truncated). */
  async setRecordingUrl(sessionId: SessionId, recordingUrl: string, durationMs?: number): Promise<ConversationSession | null> {
    if (!(await this.sessions.get(sessionId))) return null;
    return this.sessions.update(sessionId, {
      recordingUrl,
      ...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? { recordingDurationMs: Math.round(durationMs) } : {}),
    });
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
