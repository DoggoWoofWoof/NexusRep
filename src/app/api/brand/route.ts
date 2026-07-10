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
import { mergeLiveDeck, resolveBrandProfile, setupAnswersOf, toPublicBrand, tryQuestionsFromKnowledge, type LiveDeckInput } from "@modules/brand";
import { isRetrievable } from "@modules/content";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  // Resolve the profile from the Setup Assistant's answers so anything the brand user set
  // BY CHATTING (name, greeting, indication, talking points, audience) drives the live rep.
  const draft = (await c.studio.get(c.demo.aiRepId))?.draft;
  const setupAnswers = setupAnswersOf(draft);
  const brand = resolveBrandProfile(c.brand, setupAnswers);

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

  // "Try asking" chips: an explicit setup answer wins; otherwise derive from the LIVE
  // approved knowledge (ordered by slide position) so suggestions always match what the
  // rep can actually answer — including freshly approved uploads.
  const retrievable = answers
    .filter((a) => isRetrievable(a.mlr))
    .sort((a, b) => (slideById.get(String(a.detailAidSlideId))?.position ?? 999) - (slideById.get(String(b.detailAidSlideId))?.position ?? 999));
  const derived = tryQuestionsFromKnowledge(retrievable.map((a) => a.topic), brand.displayName);
  const tryQuestions = setupAnswers.try_questions?.trim()
    ? brand.tryQuestions
    : derived.length >= 2
      ? derived
      : brand.tryQuestions;

  return NextResponse.json({ ...toPublicBrand(brand), tryQuestions, deck: mergeLiveDeck(brand.deck, live) });
}
