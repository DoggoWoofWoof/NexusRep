/**
 * Shared brand-console UI style tokens. These inline-style objects were duplicated across screens
 * (BrandScreens, ActivityDashboard, StudioAgentMode…) — one source here keeps the console visually
 * consistent and lets a screen split into its own file without copying the primitives. Buttons
 * (`btnPrimary`/`btnGhost`) already live in NexusRepApp; this covers the layout/text tokens.
 */

import type { CSSProperties } from "react";

/** Uppercase section eyebrow above a screen title. */
export const eyebrow: CSSProperties = { font: "600 11px/1.2 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--dn-brand-light)", marginBottom: 6 };

/** Screen title. */
export const h1: CSSProperties = { font: "600 24px/1.2 var(--dn-font-sans)", letterSpacing: "-0.02em", margin: 0, color: "var(--dn-fg)" };

/** White surface card with the standard border + shadow. */
export const card: CSSProperties = { background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)" };

/** Table/list cell text. */
export const cell: CSSProperties = { font: "400 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" };

/** Small / medium ghost buttons (outline on white). */
export const ghostSm: CSSProperties = { padding: "8px 13px", background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 8, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer" };
export const ghostMd: CSSProperties = { padding: "10px 14px", background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer" };
