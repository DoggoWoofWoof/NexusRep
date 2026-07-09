export function isOverviewPrompt(text: string): boolean {
  const t = text.toLowerCase();
  const asksForOverview = /\b(overview|high[-\s]?level|big\s+picture|rundown|story|pitch|presentation|introduce|approved\s+information|approved\s+deck|deck|slides?)\b|walk\s+me\s+through|take\s+me\s+through|start\s+with|\bpresent\s+(it|this|the|milvexian|product|therapy|deck|slides?)/i.test(t);
  const explicitlyDeckLevel = /\b(overview|high[-\s]?level|big\s+picture|rundown|story|pitch|presentation|approved\s+information|approved\s+deck|deck|slides?)\b|walk\s+me\s+through\s+(the\s+)?(approved\s+information|approved\s+deck|deck|slides?)/i.test(t);
  const topicSpecific = /\b(librexia\s+program|mechanism|factor\s+xia|fxia|dose|dosing|apixaban|compare|comparison|safety|off[-\s]?label)\b/i.test(t);
  const aboutProduct = /\b(milvexian|product|therapy|slides?|deck|story|overview|pipeline|librexia|approved\s+information)\b/i.test(t);
  if (topicSpecific && !explicitlyDeckLevel) return false;
  return asksForOverview && aboutProduct;
}
