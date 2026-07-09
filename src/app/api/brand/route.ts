/**
 * Returns the active brand's client-safe profile: palette, greeting, detail-aid deck,
 * deck download URL, campaign chrome copy, and example questions. The browser reads
 * this (via the useBrand hook) so the HCP view, slides, and console chrome are all
 * driven by the BrandProfile — never by hardcoded brand strings in components.
 *
 * The persona/system-prompt and seed approved answers are intentionally NOT exposed
 * here (server-only); this is the outward projection (see toPublicBrand).
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { resolveBrandProfile, setupAnswersOf, toPublicBrand } from "@modules/brand";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  // Resolve the profile from the Setup Assistant's answers so anything the brand user set
  // BY CHATTING (name, greeting, indication, talking points, audience) drives the live rep.
  const draft = (await c.studio.get(c.demo.aiRepId))?.draft;
  const brand = resolveBrandProfile(c.brand, setupAnswersOf(draft));
  return NextResponse.json(toPublicBrand(brand));
}
