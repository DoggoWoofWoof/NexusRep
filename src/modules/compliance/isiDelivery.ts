/**
 * Shared ISI-delivery detection. Several routes need "has the ACTIVE ISI already been
 * delivered in this session?" (so a multi-segment overview appends it exactly once).
 * Previously each route carried its own near-copy — a wording drift between them meant
 * one route could re-deliver while another skipped. One implementation, normalized
 * whitespace, so they can never disagree.
 */

export interface AuditLikeEvent {
  type: string;
  payload: Record<string, unknown>;
}

function normalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** True if a prior response_output in this session already carried the exact ISI text. */
export function isiAlreadyDelivered(events: AuditLikeEvent[], isiText: string): boolean {
  const needle = normalized(`Important Safety Information: ${isiText}`);
  if (!normalized(isiText)) return false;
  return events.some(
    (event) =>
      event.type === "response_output" &&
      typeof event.payload.text === "string" &&
      normalized(event.payload.text).includes(needle),
  );
}

/** Remove a composer-embedded copy of the ISI (with or without its heading) from an
 *  answer body. The platform appends the exact required ISI itself, so an embedded copy
 *  either duplicates that append or re-delivers ISI a session dedup already suppressed.
 *  Deterministic — the prompt asks the model not to do this, but is never trusted to. */
export function stripEmbeddedIsi(body: string, isiText: string): string {
  const trimmed = isiText.trim();
  if (!trimmed || !body) return body;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flexible = trimmed.split(/\s+/).map(esc).join("\\s+");
  const re = new RegExp(`(?:\\*{0,2}Important Safety Information:?\\*{0,2}\\s*)?${flexible}`, "gi");
  return body.replace(re, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}
