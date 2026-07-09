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

export function useBrand(): PublicBrand | null {
  const [brand, setBrand] = useState<PublicBrand | null>(cache);
  useEffect(() => {
    if (cache) { setBrand(cache); return; }
    let alive = true;
    void load().then((b) => { if (alive) setBrand(b); });
    return () => { alive = false; };
  }, []);
  return brand;
}
