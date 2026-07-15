/**
 * First-party presentation/deck walkthrough skill. This is NexusRep's own
 * equivalent of a vendor "presentation skill": it advances through approved
 * detail-aid slides, speaks only the linked approved blocks, and returns the
 * exact slide to show. Tavus may render the avatar, but it does not own this
 * logic.
 */

import { isOk } from "@lib/result";
import { validateGrounding } from "@modules/compliance";
import type { ApprovedAnswerId, DetailAidSlideId } from "@lib/ids";
import type { ApprovedAnswer, DetailAidSlide } from "./types";
import type { ContentService, SourceValidationContext } from "./service";
import type { GroundedComposer } from "./composer";

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
  /** The pitch-plan step this segment delivers — links a spoken segment to its editable section. */
  stepId?: string;
  stepTitle?: string;
}

export interface PresentationOverviewRequest {
  context?: SourceValidationContext;
  maxSlides?: number;
  guidance?: string[];
  plan?: PresentationPlan;
}

export interface PresentationPlanStep {
  id: string;
  title: string;
  /** Approved detail-aid slide to anchor this overview section. */
  slideId?: string;
  /** Brand-authored speaker guidance. Used for ordering/cue style; medical body stays approved-source text. */
  instruction: string;
}

export interface PresentationPlan {
  steps: PresentationPlanStep[];
  updatedAt?: string;
  /** The ONE deck asset this presentation is built from (the skeleton). When set, the rendered deck
   *  and the walkthrough scope to THIS asset's slides; other approved content stays retrieval-only
   *  (RAG) supplement. Unset → the whole approved ppt deck (single-deck default). */
  deckAssetId?: string;
}

function cleanStep(step: PresentationPlanStep, fallback: PresentationPlanStep, slides: PresentationDeckSlide[], index: number): PresentationPlanStep {
  const allowedSlide = step.slideId && slides.some((s) => s.id === step.slideId) ? step.slideId : fallback.slideId;
  return {
    id: /^[a-z0-9_-]{3,80}$/i.test(step.id) ? step.id : fallback.id || `overview_step_${index + 1}`,
    title: step.title?.trim().slice(0, 90) || fallback.title || `Section ${index + 1}`,
    ...(allowedSlide ? { slideId: allowedSlide } : {}),
    instruction: step.instruction?.trim().slice(0, 500) || fallback.instruction || "",
  };
}

/**
 * The EFFECTIVE overview plan: the saved (brand-edited) plan when one exists, else the
 * DocNexus-drafted default — with every step sanitized against the current approved deck.
 * Every surface that speaks or displays the pitch must resolve the plan through this,
 * so the pitch card, the Train rehearsal, and the doctor-facing delivery always agree.
 */
export function mergePlan(saved: PresentationPlan | undefined, fallback: PresentationPlan, slides: PresentationDeckSlide[]): PresentationPlan {
  const base = saved?.steps?.length ? saved : fallback;
  const fallbackByIndex = fallback.steps;
  return {
    updatedAt: base.updatedAt ?? fallback.updatedAt,
    // The chosen skeleton deck persists with the plan (saved wins; else the fallback's).
    ...(base.deckAssetId ?? fallback.deckAssetId ? { deckAssetId: base.deckAssetId ?? fallback.deckAssetId } : {}),
    steps: base.steps.map((step, index) => cleanStep(step, fallbackByIndex[index] ?? fallback.steps[0]!, slides, index)),
  };
}

export interface PresentationDeckSlide {
  id: string;
  title: string;
  label: string;
  position: number;
  sourceId: string;
  topic: string;
  preview: string;
}

interface DeckItem {
  answer: ApprovedAnswer;
  slide: DetailAidSlide | null;
  /** Other approved answers mapped to the SAME slide — woven in by the composer to EXPAND the slide
   *  beyond its one primary block (dynamic PPT). Empty when only one answer maps to the slide. */
  related: ApprovedAnswer[];
}
type PlannedDeckItem = { item: DeckItem; step?: PresentationPlanStep };

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

/** Two topics are related if they share a meaningful content word (>=4 chars) — a light signal for
 *  "this KB block belongs with that deck slide" without a per-slide retrieval call. */
function topicsRelated(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const wb = words(b);
  for (const w of words(a)) if (wb.has(w)) return true;
  return false;
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
  if (action === "next") return `Let's move to ${where}.`;
  if (action === "previous") return `Let's go back to ${where}.`;
  if (action === "jump") return `Let's bring up ${where}.`;
  return `Sure. I'll give you a concise, slide-led overview and start with ${where}.`;
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
          `Sure. I'll keep it high-level and anchor it in the slides, starting with ${where}.`,
          `At a high level, I'll frame the story in a few parts. First, ${where}.`,
          `Let me set the stage briefly. I'll use ${where} as the starting point.`,
        ]
      : isLast
        ? [
            `To close, I'll show ${where} so the routing options are clear.`,
            `Before we wrap the overview, ${where} is the practical handoff point.`,
            `I'll finish by bringing up ${where} for the next step.`,
          ]
        : [
            `From there, I'll bring up ${where} to keep the story grounded.`,
            `A useful place to pause next is ${where}.`,
            `Then I'll move the discussion to ${where}.`,
            `The next supporting point I'll put on screen is ${where}.`,
          ];
  return pick(variants, `${seed}:${index}`);
}

function defaultStepInstruction(item: DeckItem, index: number): string {
  if (index === 0) return "Open the overview and set context from this approved slide.";
  const topic = item.answer.topic.replace(/[_-]+/g, " ");
  return `Continue the overview using the approved ${topic} points on this slide.`;
}

function planLead(index: number, total: number, title: string | undefined, step: PresentationPlanStep): string {
  const where = slidePhrase(title);
  const guide = step.instruction.toLowerCase();
  const isLast = index === total - 1;
  const brief = /\b(short|brief(?:ly)?|concise|high[- ]level|quick)\b/.test(guide);
  if (index === 0) {
    return brief
      ? `I'll start briefly with ${where}.`
      : `I'll start the overview with ${where} so the discussion is anchored in the slide.`;
  }
  if (isLast) {
    return brief
      ? `To close, I'll show ${where}.`
      : `To close this section, I'll bring up ${where} and keep the next step clear.`;
  }
  return brief
    ? `Next, I'll put ${where} on screen.`
    : `For this section, I'll put ${where} on screen and use the points there.`;
}

function resolvePlannedItems(items: DeckItem[], plan: PresentationPlan | undefined): PlannedDeckItem[] {
  const steps = (plan?.steps ?? []).filter((s) => s.slideId || s.title.trim() || s.instruction.trim());
  if (!steps.length) return items.map((item) => ({ item }));

  const bySlide = new Map(items.filter((i) => i.slide?.id).map((i) => [String(i.slide!.id), i]));
  const used = new Set<DeckItem>();
  const planned: PlannedDeckItem[] = [];

  for (const [i, step] of steps.entries()) {
    let item = step.slideId ? bySlide.get(step.slideId) : undefined;
    if (!item) {
      const query = `${step.title} ${step.instruction}`;
      item = items
        .filter((candidate) => !used.has(candidate))
        .map((candidate) => ({ candidate, score: weightedSlideScore(candidate, query) }))
        .sort((a, b) => b.score - a.score || order(a.candidate) - order(b.candidate))[0]?.candidate;
    }
    item ??= items.find((candidate) => !used.has(candidate)) ?? items[i] ?? items[0];
    if (!item) continue;
    used.add(item);
    planned.push({ item, step });
  }

  for (const item of items) {
    if (!used.has(item)) planned.push({ item });
  }
  return planned;
}

export class PresentationSkill {
  constructor(private readonly content: ContentService, private readonly composer: GroundedComposer | null = null) {}

  /** Turn a slide into spoken copy. With a composer available AND more than one approved block on
   *  the slide, the LLM weaves those blocks into a brief, grounded segment — this is what makes the
   *  PPT walkthrough DYNAMIC (expanded from the KB) rather than a verbatim recital. A single-block
   *  slide (e.g. the verbatim ISI, the contact slide) is always spoken as-is. Grounding-validated:
   *  any drift falls back to the verbatim primary block, so composition can never invent content. */
  private async composeStep(item: DeckItem, guidance: string[], index: number): Promise<{ text: string; sourceIds: ApprovedAnswerId[] }> {
    const blocks = [item.answer, ...item.related];
    const fallback = { text: item.answer.text, sourceIds: [item.answer.id] };
    if (!this.composer?.available() || blocks.length < 2) return fallback;
    const slideName = item.slide?.title ?? item.answer.topic;
    const question = `Give a brief, natural spoken segment for the "${slideName}" part of a slide-by-slide overview. Weave the approved points below into 2 to 4 sentences that cover the key facts — don't just repeat one point, and don't list them mechanically.`;
    const g = [...guidance, "This is one section of a slide walkthrough: keep it concise and conversational, and do not restate the investigational disclosure."];
    try {
      const composed = await this.composer.compose({ question, blocks, guidance: g, alreadyDisclosed: index > 0 });
      const text = composed.text.trim();
      if (text && validateGrounding({ answer: text, blocks: blocks.map((b) => b.text) }).grounded) {
        return { text, sourceIds: blocks.map((b) => b.id) };
      }
    } catch {
      /* fall back to the verbatim primary block below */
    }
    return fallback;
  }

  async deck(ctx: SourceValidationContext = {}, opts?: { assetId?: string }): Promise<PresentationDeckSlide[]> {
    return (await this.deckItems(ctx, opts?.assetId)).map((item, index) => ({
      id: item.slide?.id ? String(item.slide.id) : String(item.answer.detailAidSlideId ?? item.answer.id),
      title: item.slide?.title ?? item.answer.topic,
      label: item.slide?.label ?? `Slide ${index + 1}`,
      position: item.slide?.position ?? index + 1,
      sourceId: String(item.answer.id),
      topic: item.answer.topic,
      preview: item.answer.text.length > 150 ? `${item.answer.text.slice(0, 147).trim()}...` : item.answer.text,
    }));
  }

  /** Default plan drafted from the approved deck — optionally scoped to ONE source document
   *  (the "draft the script from this PPT" picker). Only that asset's approved slides anchor
   *  sections; everything else still answers questions via retrieval. */
  async defaultPlan(ctx: SourceValidationContext = {}, opts?: { assetId?: string }): Promise<PresentationPlan> {
    const items = await this.deckItems(ctx, opts?.assetId);
    return {
      updatedAt: new Date().toISOString(),
      steps: items.map((item, index) => ({
        id: `overview_step_${index + 1}`,
        title: item.slide?.title ?? item.answer.topic,
        slideId: item.slide?.id ? String(item.slide.id) : undefined,
        instruction: defaultStepInstruction(item, index),
      })),
    };
  }

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

    return this.buildStep(items, index, req.action, req.guidance ?? []);
  }

  async overview(req: PresentationOverviewRequest = {}): Promise<PresentationStep[]> {
    const deck = await this.deckItems(req.context ?? {});
    const planned: PlannedDeckItem[] = req.plan?.steps?.length ? resolvePlannedItems(deck, req.plan) : guidedItems(deck, req.guidance).map((item) => ({ item }));
    const total = Math.max(0, Math.min(req.maxSlides ?? planned.length, planned.length));
    const slice = planned.slice(0, total);
    return Promise.all(slice.map(({ item, step }, index) => this.buildPlannedStep(slice, item, index, index === 0 ? "start" : "next", step, req.guidance ?? [])));
  }

  private async deckItems(ctx: SourceValidationContext, assetId?: string): Promise<DeckItem[]> {
    const all = await this.content.listAnswers();
    const slides = await this.content.listSlides();
    const byId = new Map(slides.map((s) => [s.id, s]));

    // The DECK we present is GROUNDED IN THE PPT: scope to answers on ppt-kind assets (the deck),
    // unless an explicit source was picked ("draft from this PPT"). Everything else uploaded
    // (pdf / faq / script / isi) stays in the RAG for Q&A but does NOT become an overview slide, so
    // extra documents can't bloat the walkthrough. (Seeded demo has one ppt asset → no-op. If no ppt
    // asset exists at all, fall back to everything so the overview isn't empty.)
    const assets = await this.content.listAssets();
    const deckAssetIds = new Set(assets.filter((a) => a.kind === "ppt").map((a) => String(a.id)));
    const isDeck = (a: ApprovedAnswer) =>
      assetId ? String(a.contentAssetId) === assetId : deckAssetIds.size === 0 || deckAssetIds.has(String(a.contentAssetId));

    // ONE deck item per SLIDE. The first validated deck answer for a slide anchors it (primary); any
    // further deck answers on that slide become `related` blocks the composer weaves in.
    const bySlide = new Map<string, DeckItem>();
    for (const answer of all) {
      if (!answer.detailAidSlideId || !isDeck(answer)) continue;
      const checked = await this.content.validateAnswer(answer.id, ctx);
      if (!isOk(checked)) continue;
      const key = String(answer.detailAidSlideId);
      const existing = bySlide.get(key);
      if (existing) existing.related.push(checked.value);
      else bySlide.set(key, { answer: checked.value, slide: byId.get(answer.detailAidSlideId) ?? null, related: [] });
    }
    const items = [...bySlide.values()].sort((a, b) => order(a) - order(b) || String(a.answer.id).localeCompare(String(b.answer.id)));

    // SUPPLEMENT each deck slide with related KB from NON-deck sources on the same topic (validated
    // + active) — the walkthrough stays grounded in the PPT but is enriched by the wider knowledge
    // base. No-op for the seeded demo (nothing non-deck); light for uploads (a few docs).
    if (items.length) {
      const extra: ApprovedAnswer[] = [];
      for (const a of all) {
        if (isDeck(a) || !a.detailAidSlideId) continue;
        const checked = await this.content.validateAnswer(a.id, ctx);
        if (isOk(checked)) extra.push(checked.value);
      }
      for (const item of items) {
        for (const a of extra) if (topicsRelated(item.answer.topic, a.topic)) item.related.push(a);
      }
    }
    return items;
  }

  private async buildStep(items: DeckItem[], index: number, action: PresentationAction, guidance: string[] = [], overview = false): Promise<PresentationStep> {
    const item = items[index]!;
    const title = item.slide?.title ?? item.slide?.label;
    const intro = overview ? overviewLead(index, items.length, title, String(item.answer.id)) : lead(action, title);
    // The intro is already the human slide cue ("Let's move to ..."). The body is composed from the
    // slide's approved blocks (or verbatim primary when there's nothing to weave / no composer).
    const { text: body, sourceIds } = await this.composeStep(item, guidance, index);
    return {
      action,
      index,
      total: items.length,
      text: `${intro} ${body}`,
      sourceIds,
      detailAidSlideId: item.answer.detailAidSlideId,
      slideTitle: title,
    };
  }

  private async buildPlannedStep(planned: PlannedDeckItem[], item: DeckItem, index: number, action: PresentationAction, step?: PresentationPlanStep, guidance: string[] = []): Promise<PresentationStep> {
    const title = item.slide?.title ?? item.slide?.label;
    const intro = step ? planLead(index, planned.length, title, step) : overviewLead(index, planned.length, title, String(item.answer.id));
    const stepGuidance = step?.instruction ? [...guidance, step.instruction] : guidance;
    const { text: body, sourceIds } = await this.composeStep(item, stepGuidance, index);
    return {
      action,
      index,
      total: planned.length,
      text: `${intro} ${body}`,
      sourceIds,
      detailAidSlideId: item.answer.detailAidSlideId,
      slideTitle: title,
      ...(step ? { stepId: step.id, stepTitle: step.title } : {}),
    };
  }
}
