"use client";

/**
 * Client hook for the active brand's public profile (palette, greeting, deck, campaign
 * copy, try-questions). Fetched once from /api/brand and cached at module scope, so every
 * consumer (SlideView, HcpExperience, the console header) reads the SAME brand config
 * without prop-threading — and a new brand needs zero component edits.
 *
 * Returns null until the first fetch resolves; callers render a light placeholder.
 */

import { useEffect, useState } from "react";
import type { PublicBrand } from "@modules/brand";

let cache: PublicBrand | null = null;
let inflight: Promise<PublicBrand | null> | null = null;
const BRAND_CHANGED = "nexusrep:brand-changed";

function load(): Promise<PublicBrand | null> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/brand")
      .then((r) => (r.ok ? (r.json() as Promise<PublicBrand>) : null))
      .then((b) => { if (b) cache = b; return b; })
      .catch(() => null);
  }
  return inflight;
}

export function invalidateBrandCache(): void {
  cache = null;
  inflight = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BRAND_CHANGED));
}

export function useBrand(): PublicBrand | null {
  const [brand, setBrand] = useState<PublicBrand | null>(cache);
  useEffect(() => {
    let alive = true;

    const refresh = () => {
      cache = null;
      inflight = null;
      void load().then((b) => { if (alive) setBrand(b); });
    };

    if (cache) setBrand(cache);
    else refresh();
    window.addEventListener(BRAND_CHANGED, refresh);
    return () => {
      alive = false;
      window.removeEventListener(BRAND_CHANGED, refresh);
    };
  }, []);
  return brand;
}
