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
import { mergeLiveDeck, resolveBrandProfile, setupAnswersOf, toPublicBrand, type LiveDeckInput } from "@modules/brand";
import { isRetrievable } from "@modules/content";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  // Resolve the profile from the Setup Assistant's answers so anything the brand user set
  // BY CHATTING (name, greeting, indication, talking points, audience) drives the live rep.
  const draft = (await c.studio.get(c.demo.aiRepId))?.draft;
  const brand = resolveBrandProfile(c.brand, setupAnswersOf(draft));

  // The on-screen deck = the authored profile deck + LIVE approved content (uploads that
  // cleared MLR). This is what lets a brand configured purely by chat + upload render real
  // slides in the HCP view — the detail aid follows the content module, never a static deck.
  const [answers, slides] = await Promise.all([c.content.listAnswers(), c.content.listSlides()]);
  const slideById = new Map(slides.map((s) => [String(s.id), s]));
  const live = answers
    .filter((a) => isRetrievable(a.mlr) && a.detailAidSlideId)
    .map((a): LiveDeckInput | null => {
      const slide = slideById.get(String(a.detailAidSlideId));
      return slide ? { id: String(slide.id), title: slide.title, label: slide.label, position: slide.position, text: a.text } : null;
    })
    .filter((s): s is LiveDeckInput => s !== null);

  return NextResponse.json({ ...toPublicBrand(brand), deck: mergeLiveDeck(brand.deck, live) });
}
