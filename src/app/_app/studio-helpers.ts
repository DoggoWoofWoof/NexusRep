/**
 * Pure Studio helpers (no React, no closures) shared by the Studio modes — extracted from
 * StudioScreen so that big screen focuses on rendering.
 */

/** True when a section's slide chip would just repeat the section label (so we hide the chip). */
export function slideChipRedundant(sectionLabel?: string | null, slideTitle?: string | null): boolean {
  if (!slideTitle) return true;
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  return !!sectionLabel && norm(sectionLabel) === norm(slideTitle);
}

/** A fresh rehearsal (preview) session id, distinct from real HCP sessions. */
export function makePreviewSessionId(): string {
  return `session_train_preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Split a rep answer into [body, ISI] on the verbatim ISI marker (ISI is null when absent). */
export function splitIsi(text: string): [string, string | null] {
  const parts = text.split(/\n\nImportant Safety Information:\s*/);
  return parts.length > 1 ? [parts[0]!.trim(), parts.slice(1).join(" ").trim()] : [text, null];
}
