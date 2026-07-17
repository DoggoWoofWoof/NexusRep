/**
 * Pure helpers for classifying/estimating live video-call events, factored out of VideoAgentStage so
 * that big stateful component stays focused on the transport wiring. No React, no closures — just
 * functions over vendor event shapes and text.
 */

/** Estimate how long the replica will speak a line (ms), for pacing captions/slide cues. */
export function estimateReplicaSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(45_000, Math.max(2_400, words * 430 + 1_200));
}

/** Is this raw vendor event from the DOCTOR (user) side? */
export function isHcpRawEvent(e: { type: string; role: string }): boolean {
  const role = e.role.toLowerCase();
  const type = e.type.toLowerCase();
  return /\b(hcp|user|human|participant|remote)\b/.test(role) ||
    /(?:^|[._-])(?:user|hcp|human|participant|remote)(?:[._-]|$)/.test(type);
}

/** Is this raw vendor event from the REP (replica/agent) side? (Doctor events take precedence.) */
export function isRepRawEvent(e: { type: string; role: string }): boolean {
  if (isHcpRawEvent(e)) return false;
  const role = e.role.toLowerCase();
  const type = e.type.toLowerCase();
  return /\b(replica|assistant|agent|ai|pal|face)\b/.test(role) ||
    /(?:^|[._-])(?:replica|assistant|agent|pal|face)(?:[._-]|$)/.test(type);
}
