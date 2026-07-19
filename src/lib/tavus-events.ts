/**
 * Turn raw Tavus lifecycle webhook events into ADMIN-READABLE activity lines — so the Activity feed
 * says "Video call ended — the doctor left / disconnected" instead of "Tavus system.shutdown", and an
 * operator can tell a deliberate End from a timeout / max-duration / error WITHOUT reading raw logs.
 * Pure + testable; the webhook route consumes it.
 */

type Severity = "info" | "notice" | "warn" | "error";

// Tavus `system.shutdown` reasons → plain English. Extend as new reasons are observed; unknown values
// fall back to a de-underscored version so nothing is dropped.
const SHUTDOWN_REASONS: Record<string, string> = {
  end_call: "ended by request (End button / hang-up)",
  end_conversation: "ended by request (End button / hang-up)",
  ended: "ended by request (End button / hang-up)",
  participant_left_timeout: "the doctor left / disconnected",
  participant_left: "the doctor left / disconnected",
  participant_absent_timeout: "the doctor stopped responding",
  no_participant_joined_timeout: "no one joined in time",
  max_call_duration: "reached the maximum call length",
  max_call_duration_reached: "reached the maximum call length",
  maximum_call_duration_reached: "reached the maximum call length",
  replica_error: "a replica (avatar) error",
  system_error: "a system error",
  error: "an error",
};

/** A shutdown reason string → plain English (unknown → de-underscored). */
export function shutdownReasonText(raw: string): string {
  const key = raw.trim().toLowerCase();
  return SHUTDOWN_REASONS[key] ?? (key.replace(/_/g, " ") || "an unspecified reason");
}

/** A stored session `endReason` → plain English. Covers our own "ended_by_doctor" (client End click)
 *  as well as any Tavus shutdown reason. Used by Session review + the admin feed. */
export function endReasonText(reason: string): string {
  return reason.trim().toLowerCase() === "ended_by_doctor" ? "Doctor pressed End" : shutdownReasonText(reason);
}

/** Pull the shutdown reason out of a Tavus event's properties (a few field names Tavus has used). */
export function shutdownReasonOf(properties: Record<string, unknown> = {}): string | null {
  const raw = String(properties.shutdown_reason ?? properties.reason ?? properties.end_reason ?? "").trim();
  return raw || null;
}

export interface TavusEventDescription {
  /** Human, admin-facing phrase for the activity feed. */
  action: string;
  severity: Severity;
  /** Normalized end reason for a shutdown (null otherwise) — also stored as the session's endReason. */
  reason: string | null;
}

export function describeTavusEvent(event: string, properties: Record<string, unknown> = {}): TavusEventDescription {
  const e = event.toLowerCase();
  if (/shutdown|conversation[._]ended|call[._]ended/.test(e)) {
    const raw = shutdownReasonOf(properties);
    if (!raw) return { action: "Video call ended", severity: "notice", reason: null };
    const severity: Severity = /error|fail|crash/i.test(raw) ? "warn" : "notice";
    return { action: `Video call ended — ${shutdownReasonText(raw)}`, severity, reason: raw };
  }
  if (/replica[._]joined|pal[._]joined|started/.test(e)) return { action: "Video call connected (rep joined)", severity: "info", reason: null };
  if (/transcription[._]ready|transcript/.test(e)) return { action: "Video transcript ready", severity: "info", reason: null };
  if (/recording[._]ready/.test(e)) return { action: "Video recording ready", severity: "info", reason: null };
  if (/error|fail/.test(e)) return { action: `Video error — ${event}`, severity: "warn", reason: null };
  return { action: `Video: ${event || "event"}`, severity: "info", reason: null };
}
