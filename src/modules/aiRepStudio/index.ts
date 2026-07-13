/**
 * AI Rep Studio domain (brief §5–9, §16). Owns the AIRep + persona + readiness
 * model that the Build/Train/Audience/Launch/Improve lifecycle operates on.
 */

import type { AiRepId, BrandId, CampaignId, PersonaId } from "@lib/ids";

export type LifecycleMode = "build" | "train" | "audience" | "launch" | "improve";

export type RepState = "draft" | "in_review" | "ready" | "live";

export interface AIRepPersona {
  id: PersonaId;
  type: "brand_persona" | "rep_clone";
  displayName: string;
  voiceStyle: "professional" | "warm" | "clinical";
  disclosureText: string;
  greeting: string;
}

export interface AIRep {
  id: AiRepId;
  brandId: BrandId;
  campaignId: CampaignId;
  persona: AIRepPersona;
  state: RepState;
}

export interface ReadinessItem {
  key: string;
  label: string;
  done: boolean;
  blocking: boolean;
}

/** Map a persona voice tone to a STYLE directive for the composer. Phrasing only — it is
 *  layered UNDER the composer's absolute grounding rules and the compliance gate, so it can
 *  never add a fact, number, or claim; it only changes HOW approved content is worded. This
 *  is what makes the "tone" choice actually change what the rep says. */
export function toneDirective(style?: string): string {
  switch (style) {
    case "professional":
      return "Speak in a crisp, professional tone — lead with the point, minimal preamble, no filler.";
    case "warm":
      return "Speak in a warm, conversational tone — approachable and human, like a helpful colleague.";
    case "clinical":
      return "Speak in a measured, clinical, data-first tone — precise and understated.";
    default:
      return "";
  }
}

/** Readiness score = share of completed items; launch requires no blocking items. */
export function readiness(items: ReadinessItem[]): { pct: number; canLaunch: boolean } {
  if (items.length === 0) return { pct: 0, canLaunch: false };
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  const canLaunch = items.every((i) => i.done || !i.blocking);
  return { pct, canLaunch };
}

export { StudioService, type StudioState, type StudioSnapshot } from "./service";
