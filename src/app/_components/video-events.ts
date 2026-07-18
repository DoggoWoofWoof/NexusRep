/**
 * Pure helpers for classifying/estimating live video-call events, factored out of VideoAgentStage so
 * that big stateful component stays focused on the transport wiring. No React, no closures — just
 * functions over vendor event shapes and text.
 */

import { estimateReplicaTurnMs } from "@lib/pacing";

/** How long a live replica turn takes (startup latency + speaking time), for pacing captions/slide
 *  cues and the turn-done / barge-in safety windows. Sourced from the MEASURED replica rate in
 *  @lib/pacing (Tavus Cartesia sonic-3 ≈301 ms/word + ~1.2s startup) — previously a hard-coded,
 *  startup-inflated 430 ms/word here. */
export const estimateReplicaSpeechMs = estimateReplicaTurnMs;

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
