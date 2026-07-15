"use client";

/**
 * Renders the active brand's detail-aid deck as branded, on-screen slides — the same
 * content the rep "shows" during a conversation and that the .pptx is generated from.
 * Deck + palette come from the brand profile (via useBrand → /api/brand), so this is
 * brand-agnostic: a new brand needs no edits here. Used in the HCP view + the session replay.
 */

import { useEffect, useState } from "react";
import { useBrand } from "./useBrand";
import type { BrandPalette, DeckSlide } from "@modules/brand";

const c = (hex: string) => `#${hex}`;

function Slide({ s, pal, eyebrow, badge, fill = false }: { s: DeckSlide; pal: BrandPalette; eyebrow: string; badge: string; fill?: boolean }) {
  const isTitle = s.kind === "title";
  return (
    <div
      style={{
        position: "relative",
        ...(fill ? { flex: 1, minHeight: 0 } : { aspectRatio: "16 / 9" }),
        borderRadius: 10,
        overflow: "hidden",
        background: isTitle ? c(pal.navy) : c(pal.paper),
        border: `1px solid ${c(pal.mist)}`,
        color: isTitle ? "#fff" : c(pal.ink),
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* left brand rail */}
      {!isTitle && (
        <>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, background: c(pal.navy) }} />
          <div style={{ position: "absolute", left: 6, top: 0, bottom: 0, width: 2, background: c(pal.red) }} />
        </>
      )}
      <div style={{ padding: isTitle ? "34px 30px" : "22px 26px 20px 34px", display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ font: "700 10px/1 var(--dn-font-sans)", letterSpacing: "2px", color: isTitle ? "#7FA0C8" : c(pal.navy) }}>{eyebrow}</span>
          <span style={{ font: "700 9px/1 var(--dn-font-sans)", letterSpacing: "1px", color: c(pal.red) }}>{badge}</span>
        </div>

        {isTitle ? (
          <div style={{ marginTop: "auto", marginBottom: "auto" }}>
            <div style={{ font: "700 34px/1.05 var(--dn-font-sans)", letterSpacing: "-0.02em" }}>{s.title}</div>
            <div style={{ width: 90, height: 4, background: c(pal.red), margin: "12px 0 14px" }} />
            <div style={{ font: "500 15px/1.3 var(--dn-font-sans)", color: "#AFC4E4" }}>{s.subtitle}</div>
            <div style={{ marginTop: 10, font: "400 11px/1.5 var(--dn-font-sans)", color: "#AFC4E4" }}>
              {(s.bullets ?? []).map((b, i) => <div key={i}>{b}</div>)}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, flex: 1, minHeight: 0, overflow: "hidden" }}>
            <div style={{ font: "700 21px/1.15 var(--dn-font-sans)", color: c(pal.ink) }}>{s.title}</div>
            {s.subtitle && <div style={{ font: "600 12px/1.3 var(--dn-font-sans)", color: c(pal.red), margin: "5px 0 10px" }}>{s.subtitle}</div>}
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 7 }}>
              {(s.bullets ?? []).map((b, i) => (
                <li key={i} style={{ font: "400 12px/1.4 var(--dn-font-sans)", color: c(pal.ink) }}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ marginTop: "auto", paddingTop: 8, font: "400 8.5px/1.3 var(--dn-font-sans)", fontStyle: "italic", color: isTitle ? "#7FA0C8" : c(pal.slate) }}>
          {s.footnote}
        </div>
      </div>
    </div>
  );
}

/**
 * Deck viewer with prev/next + a real .pptx download. When `focusId` changes it jumps to
 * that slide — used to follow the conversation (show the slide the rep referenced for the
 * latest answer / selected transcript turn). Deck + palette + download URL come from the brand.
 */
export function SlideView({ focusId, compact = false, fill = false }: { focusId?: string; compact?: boolean; fill?: boolean }) {
  const brand = useBrand();
  const deck = brand?.deck ?? [];
  const idxOf = (id?: string) => { const n = deck.findIndex((s) => s.id === id); return n < 0 ? 0 : n; };
  const [i, setI] = useState(0);
  useEffect(() => { if (focusId && deck.length) setI(idxOf(focusId)); }, [focusId, deck.length]);

  if (!brand || deck.length === 0) {
    // Distinguish "still fetching" from "brand loaded, but no slides yet" — an empty deck is the
    // real state for a clean account (or a configured brand before content is approved), not a
    // perpetual spinner. Message stays neutral so it's safe in the doctor view too (no jargon).
    const msg = !brand ? "Loading deck…" : "No slides yet.";
    return (
      <div style={fill ? { flex: 1, minHeight: 0, display: "flex" } : { aspectRatio: "16 / 9", display: "flex" }}>
        <div style={{ margin: "auto", font: "500 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{msg}</div>
      </div>
    );
  }

  const pal = brand.palette;
  const eyebrow = brand.displayName.toUpperCase();
  const badge = brand.investigational ? "INVESTIGATIONAL" : "";
  const slide = deck[Math.min(i, deck.length - 1)]!;
  return (
    <div style={fill ? { display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 } : { display: "grid", gap: 8 }}>
      <Slide s={slide} pal={pal} eyebrow={eyebrow} badge={badge} fill={fill} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
        {/* Arrows flank only the fixed-width counter, so they NEVER shift when the slide title changes
            length. The title sits AFTER the › and truncates instead of pushing the arrows around. */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          <button onClick={() => setI((v) => Math.max(0, v - 1))} disabled={i === 0} style={navBtn(i === 0)}>‹</button>
          <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", minWidth: 38, textAlign: "center", flex: "none" }}>{i + 1} / {deck.length}</span>
          <button onClick={() => setI((v) => Math.min(deck.length - 1, v + 1))} disabled={i === deck.length - 1} style={navBtn(i === deck.length - 1)}>›</button>
          <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>· {slide.label}</span>
        </div>
        {!compact && (
          <a href={brand.deckPptxUrl} download style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", textDecoration: "none" }}>
            ↓ Download deck (.pptx)
          </a>
        )}
      </div>
    </div>
  );
}

function navBtn(disabled: boolean): React.CSSProperties {
  return { width: 26, height: 26, borderRadius: 6, border: "1px solid var(--dn-border)", background: "var(--dn-surface)", color: disabled ? "var(--dn-fg-subtle)" : "var(--dn-fg)", cursor: disabled ? "default" : "pointer", fontSize: 15, lineHeight: 1 };
}
