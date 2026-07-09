export function isOverviewPrompt(text: string): boolean {
  const t = text.toLowerCase();
  const asksForOverview = /\b(overview|high[-\s]?level|big\s+picture|rundown|story|pitch|presentation|introduce)\b|walk\s+me\s+through|take\s+me\s+through|start\s+with|what\s+should\s+i\s+know|\bpresent\s+(it|this|the|milvexian|product|therapy|program|deck|slides?)/i.test(t);
  const aboutProduct = /\b(milvexian|product|therapy|program|slides?|deck|story|overview|pipeline|librexia)\b/i.test(t);
  return asksForOverview && aboutProduct;
}
