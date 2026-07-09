/**
 * Training (brief §6, §9). Rehearsal + transcript coaching. Coaching comments
 * feed @modules/rules to generate draft rules. Training feedback never bypasses
 * compliance — see the status logic in @modules/rules.
 */

import type { SessionId, TrainingSessionId, TurnId } from "@lib/ids";

export type TrainingSource = "rehearsal" | "real_session" | "recording" | "review_comment";

export interface TrainingComment {
  turnId: TurnId;
  text: string;
  /** Optional highlighted phrase the comment targets. */
  highlight?: string;
}

export interface TrainingSession {
  id: TrainingSessionId;
  source: TrainingSource;
  /** The conversation being coached (rehearsal or real). */
  sessionId: SessionId;
  comments: TrainingComment[];
}

// TODO(stage 6): TrainingService — rehearsal loop, comment capture, retest with active rules.
