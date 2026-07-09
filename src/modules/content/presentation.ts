/**
 * First-party presentation/deck walkthrough skill. This is NexusRep's own
 * equivalent of a vendor "presentation skill": it advances through approved
 * detail-aid slides, speaks only the linked approved blocks, and returns the
 * exact slide to show. Tavus may render the avatar, but it does not own this
 * logic.
 */

import { isOk } from "@lib/result";
import type { ApprovedAnswerId, DetailAidSlideId } from "@lib/ids";
import type { ApprovedAnswer, DetailAidSlide } from "./types";
import type { ContentService, SourceValidationContext } from "./service";

export type PresentationAction = "start" | "next" | "previous" | "jump";

export interface PresentationRequest {
  action: PresentationAction;
  currentSlideId?: string;
  query?: string;
  context?: SourceValidationContext;
  guidance?: string[];
}

export interface PresentationStep {
  action: PresentationAction;
  index: number;
  total: number;
  text: string;
  sourceIds: ApprovedAnswerId[];
  detailAidSlideId?: DetailAidSlideId;
  slideTitle?: string;
}

export interface PresentationOverviewRequest {
  context?: SourceValidationContext;
  maxSlides?: number;
  guidance?: string[];
}

interface DeckItem {
  answer: ApprovedAnswer;
  slide: DetailAidSlide | null;
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

function score(item: DeckItem, query: string): number {
  const hay = `${item.answer.topic} ${item.answer.text} ${item.slide?.title ?? ""} ${item.slide?.label ?? ""}`.toLowerCase();
  return words(query).reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

function weightedSlideScore(item: DeckItem, query: string): number {
  const slideHay = `${item.answer.topic} ${item.slide?.title ?? ""} ${item.slide?.label ?? ""}`.toLowerCase();
  const bodyHay = item.answer.text.toLowerCase();
  return words(query).reduce((n, w) => n + (slideHay.includes(w) ? 3 : 0) + (bodyHay.includes(w) ? 1 : 0), 0);
}

function order(item: DeckItem): number {
  if (item.slide?.position != null) return item.slide.position;
  const fromLabel = item.slide?.label.match(/\b(?:slide|page)\s+(\d+)/i)?.[1];
  return fromLabel ? Number(fromLabel) : Number.MAX_SAFE_INTEGER;
}

function guidanceText(guidance: string[] | undefined): string {
  return (guidance ?? []).map((g) => g.trim()).filter(Boolean).join(" ");
}

function leadWeight(item: DeckItem, guidance: string | undefined): number {
  const g = guidance?.trim();
  if (!g) return 0;
  const lower = g.toLowerCase();
  const wantsLead = /\b(lead|start|open|begin|first|prioriti(?:ze|se)|earlier|before|show .* first|use .* first)\b/.test(lower);
  if (!wantsLead) return 0;
  return weightedSlideScore(item, lower);
}

function guidedItems(items: DeckItem[], guidance: string[] | undefined): DeckItem[] {
  const guide = guidanceText(guidance);
  if (!guide) return items;
  return [...items].sort((a, b) => leadWeight(b, guide) - leadWeight(a, guide) || order(a) - order(b) || String(a.answer.id).localeCompare(String(b.answer.id)));
}

function lead(action: PresentationAction, title?: string): string {
  const where = slidePhrase(title);
  if (action === "next") return `Next, let's move to ${where}.`;
  if (action === "previous") return `Let's go back to ${where}.`;
  if (action === "jump") return `Let's jump to ${where}.`;
  return `Let's walk through the approved deck. We'll start with ${where}.`;
}

function pick<T>(items: T[], seed: string): T {
  let h = 17;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return items[h % items.length]!;
}

function slidePhrase(title: string | undefined): string {
  if (!title) return "this slide";
  if (/^the\b/i.test(title)) return `${title.replace(/^The\b/, "the")} slide`;
  return `the ${title} slide`;
}

function overviewLead(index: number, total: number, title: string | undefined, seed: string): string {
  const where = slidePhrase(title);
  const isLast = index === total - 1;
  const variants =
    index === 0
      ? [
          `Sure. I’ll keep it high-level and anchor it in the slides, starting with ${where}.`,
          `At a high level, I’d frame the story in a few parts. First, ${where}.`,
          `Let me set the stage briefly. I’ll use ${where} as the starting point.`,
        ]
      : isLast
        ? [
            `To close, I’d show ${where} so the routing options are clear.`,
            `Before we wrap the overview, ${where} is the practical handoff point.`,
            `I’d finish by bringing up ${where} for the next step.`,
          ]
        : [
            `From there, I’d bring up ${where} to keep the story grounded.`,
            `A useful place to pause next is ${where}.`,
            `Then I’d move the discussion to ${where}.`,
            `The next supporting point I’d put on screen is ${where}.`,
          ];
  return pick(variants, `${seed}:${index}`);
}

export class PresentationSkill {
  constructor(private readonly content: ContentService) {}

  async step(req: PresentationRequest): Promise<PresentationStep | null> {
    const items = guidedItems(await this.deckItems(req.context ?? {}), req.guidance);
    if (!items.length) return null;

    let index = 0;
    const current = req.currentSlideId ? items.findIndex((i) => i.slide?.id === req.currentSlideId) : -1;
    if (req.action === "next") index = Math.min(items.length - 1, Math.max(0, current) + 1);
    else if (req.action === "previous") index = Math.max(0, (current < 0 ? 1 : current) - 1);
    else if (req.action === "jump" && req.query?.trim()) {
      index = items
        .map((item, i) => ({ i, s: score(item, req.query!) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)[0]?.i ?? 0;
    }

    return this.buildStep(items, index, req.action);
  }

  async overview(req: PresentationOverviewRequest = {}): Promise<PresentationStep[]> {
    const items = guidedItems(await this.deckItems(req.context ?? {}), req.guidance);
    const total = Math.max(0, Math.min(req.maxSlides ?? items.length, items.length));
    return items.slice(0, total).map((_item, index) => this.buildStep(items, index, index === 0 ? "start" : "next", true));
  }

  private async deckItems(ctx: SourceValidationContext): Promise<DeckItem[]> {
    const answers = await this.content.listAnswers();
    const slides = await this.content.listSlides();
    const byId = new Map(slides.map((s) => [s.id, s]));
    const valid: DeckItem[] = [];

    for (const answer of answers) {
      const checked = await this.content.validateAnswer(answer.id, ctx);
      if (isOk(checked) && answer.detailAidSlideId) {
        valid.push({ answer: checked.value, slide: byId.get(answer.detailAidSlideId) ?? null });
      }
    }

    return valid.sort((a, b) => order(a) - order(b) || String(a.answer.id).localeCompare(String(b.answer.id)));
  }

  private buildStep(items: DeckItem[], index: number, action: PresentationAction, overview = false): PresentationStep {
    const item = items[index]!;
    const title = item.slide?.title ?? item.slide?.label;
    const intro = overview ? overviewLead(index, items.length, title, String(item.answer.id)) : lead(action, title);
    // The presentation intro is already the human slide cue ("Next, let's move to ...").
    // Do not add the generic response-builder slide sentence here, or a walkthrough
    // repeats itself on every slide.
    const text = `${intro} ${item.answer.text}`;
    return {
      action,
      index,
      total: items.length,
      text,
      sourceIds: [item.answer.id],
      detailAidSlideId: item.answer.detailAidSlideId,
      slideTitle: title,
    };
  }
}
