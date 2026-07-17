/**
 * Small pure formatting helpers shared by client + server. Each was copy-pasted in 2-3 places
 * (mm:ss duration, name/username initials) — one definition keeps them consistent and testable.
 */

/** Seconds → "MM:SS" (zero-padded). */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Up to two uppercase initials from a display name OR a username (handles "." "_" "-" separators). */
export function initials(name: string): string {
  const parts = name.replace(/[._-]/g, " ").trim().split(/\s+/).filter(Boolean);
  const two = ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  return two || name.slice(0, 2).toUpperCase() || "?";
}
