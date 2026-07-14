/**
 * Doctor-transcript append rule — the single source of truth for how a spoken/typed turn lands in
 * the captions panel (which IS the transcript, and the audit record the review view renders).
 *
 * The ONLY thing suppressed is a CONSECUTIVE re-emit of the same speaker's identical text: Tavus
 * streams an utterance and then finalizes it, and a typed ask is echoed back by the replica. Those
 * arrive back-to-back with nothing in between, so the last message is enough to catch them.
 *
 * It must NEVER drop a turn just because its text repeats one given earlier in the conversation.
 * A follow-up like "how does it work?" after "how does Milvexian work?" legitimately yields the
 * same approved answer; an over-eager "does this text already appear anywhere?" check silently ate
 * that turn and left the rep's answer missing from the transcript (the "caption sometimes doesn't
 * show up" bug). An HCP question between two identical answers means the second is a real new turn.
 */

export interface TranscriptMsg {
  role: "hcp" | "rep";
  text: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Return the transcript with `text` appended as a `role` turn, unless it is an immediate re-emit of
 * the same speaker's identical last message. Pure: returns the same array reference when nothing
 * changes (empty text or a suppressed re-emit) so a React state setter is a no-op in that case.
 */
export function appendTurn(msgs: TranscriptMsg[], role: TranscriptMsg["role"], text: string): TranscriptMsg[] {
  const t = text.trim();
  if (!t) return msgs;
  const last = msgs[msgs.length - 1];
  if (last && last.role === role && norm(last.text) === norm(t)) return msgs;
  return [...msgs, { role, text: t }];
}
