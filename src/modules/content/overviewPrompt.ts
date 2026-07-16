/**
 * Detects a deck-level "give me the overview" ask (vs a specific topic question that
 * should go through normal retrieval). GENERIC phrasing only — the brand's product/
 * program names come from the optional lexicon (BrandProfile.lexicon.productTerms),
 * so onboarding a new brand never edits this engine file.
 */
export function isOverviewPrompt(text: string, lexicon?: { productTerms?: string[] }): boolean {
  const t = text.toLowerCase();
  const productTerms = (lexicon?.productTerms ?? []).map((x) => x.toLowerCase().trim()).filter(Boolean);
  const mentionsProductName = productTerms.some((term) => t.includes(term));

  // A question ABOUT what the approved information contains ("what does the approved information cover
  // on sponsor & collaboration?", "does the approved information mention dosing?") is a SPECIFIC
  // question — answer it through normal retrieval, NOT the deck walkthrough. Without this the bare
  // words "approved information" (a legitimate deck-level signal in "walk me through the approved
  // information") swallow it — which is exactly how the auto-generated "What does the approved
  // information cover on X?" try-chips wrongly launched the whole overview.
  const questionAboutApprovedInfo =
    /\bapproved\s+information\b/.test(t) &&
    /\b(what|what's|whats|which|does|do|is|are)\b/.test(t) &&
    /\b(cover|covers|covered|say|says|include|includes|mention|mentions|state|states|about|on|regarding)\b/.test(t);
  if (questionAboutApprovedInfo) return false;

  const asksForOverview =
    /\b(overview|high[-\s]?level|big\s+picture|rundown|story|pitch|presentation|introduce|approved\s+information|approved\s+deck|deck|slides?)\b|walk\s+me\s+through|take\s+me\s+through|start\s+with|\bpresent\s+(it|this|the|product|therapy|deck|slides?)/i.test(t) ||
    (mentionsProductName && /\bpresent\b/i.test(t));
  const explicitlyDeckLevel =
    /\b(overview|high[-\s]?level|big\s+picture|rundown|story|pitch|presentation|approved\s+information|approved\s+deck|deck|slides?)\b|walk\s+me\s+through\s+(the\s+)?(approved\s+information|approved\s+deck|deck|slides?)/i.test(t);
  // A specific clinical topic (mechanism, dosing, comparisons, safety…) means the doctor
  // asked a QUESTION, not for the walkthrough — unless they explicitly asked deck-level.
  const topicSpecific = /\b(mechanism|dose|dosing|compare|comparison|safety|off[-\s]?label)\b|\bprogram\b.*\?/i.test(t);
  const aboutProduct =
    mentionsProductName || /\b(product|therapy|slides?|deck|presentation|pitch|story|overview|pipeline|approved\s+information)\b/i.test(t);

  if (topicSpecific && !explicitlyDeckLevel) return false;
  return asksForOverview && aboutProduct;
}
