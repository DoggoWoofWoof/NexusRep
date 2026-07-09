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

/** Readiness score = share of completed items; launch requires no blocking items. */
export function readiness(items: ReadinessItem[]): { pct: number; canLaunch: boolean } {
  if (items.length === 0) return { pct: 0, canLaunch: false };
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  const canLaunch = items.every((i) => i.done || !i.blocking);
  return { pct, canLaunch };
}

export { StudioService, type StudioState, type StudioSnapshot } from "./service";
