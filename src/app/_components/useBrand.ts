"use client";

/**
 * Client hook for the active brand's public profile (palette, greeting, deck, campaign
 * copy, try-questions). Fetched once from /api/brand and cached at module scope, so every
 * consumer (SlideView, HcpExperience, the console header) reads the SAME brand config
 * without prop-threading — and a new brand needs zero component edits.
 *
 * Resilient by design: a failed fetch (e.g. a 500 while the dev server compiles routes, or
 * a cold serverless boot) must never strand a mounted component at null forever. Failures
 * clear the inflight promise so the next consumer retries, mounted consumers retry on a
 * short backoff, and a late success broadcasts to EVERY mounted consumer — not only the
 * one whose fetch happened to win.
 *
 * Returns null until the first successful fetch; callers render a light placeholder.
 */

import { useEffect, useState } from "react";
import type { PublicBrand } from "@modules/brand";

let cache: PublicBrand | null = null;
let inflight: Promise<PublicBrand | null> | null = null;
const BRAND_CHANGED = "nexusrep:brand-changed";
const RETRY_MS = 1600;
const MAX_RETRIES = 6;

function load(): Promise<PublicBrand | null> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/brand")
      .then((r) => (r.ok ? (r.json() as Promise<PublicBrand>) : null))
      .catch(() => null)
      .then((b) => {
        inflight = null; // failure → the next call retries; success → cache serves everyone
        if (b) {
          cache = b;
          // Wake every mounted consumer — including ones whose own fetch failed earlier.
          if (typeof window !== "undefined") window.dispatchEvent(new Event(BRAND_CHANGED));
        }
        return b;
      });
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
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = () => {
      void load().then((b) => {
        if (!alive) return;
        if (b) setBrand(b);
        else if (retries < MAX_RETRIES) {
          retries += 1;
          timer = setTimeout(attempt, RETRY_MS); // cold-start 500s resolve within a few seconds
        }
      });
    };

    // A brand change (or a late first success) re-reads the shared cache; a cleared cache
    // (invalidateBrandCache) triggers a fresh fetch.
    const onChanged = () => {
      if (!alive) return;
      retries = 0;
      if (cache) setBrand(cache);
      else attempt();
    };

    if (cache) setBrand(cache);
    else attempt();
    window.addEventListener(BRAND_CHANGED, onChanged);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener(BRAND_CHANGED, onChanged);
    };
  }, []);
  return brand;
}
