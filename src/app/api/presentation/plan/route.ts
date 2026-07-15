/**
 * Guided-overview plan controller. The plan is the trainable script structure:
 * ordered sections, each anchored to an approved detail-aid slide. The spoken
 * medical body still comes from the approved content block for that slide.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { mergePlan, PresentationSkill, type PresentationDeckSlide, type PresentationPlan, type PresentationPlanStep } from "@modules/content";

export const dynamic = "force-dynamic";

function contextOf(c: Awaited<ReturnType<typeof getContainer>>) {
  return { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market };
}

function parseStepIndex(feedback: string): number | null {
  const m = feedback.match(/\b(?:step|section|paragraph|line)\s*(\d{1,2})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n - 1 : null;
}

function parseSlide(feedback: string, slides: PresentationDeckSlide[]): PresentationDeckSlide | null {
  const byNumber = feedback.match(/\bslide\s*(\d{1,2})\b/i);
  if (byNumber) {
    const n = Number(byNumber[1]);
    return slides.find((s) => s.position === n) ?? slides[n - 1] ?? null;
  }
  const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
  const fw = words(feedback);
  if (!fw.length) return null;
  return slides
    .map((slide) => {
      const hay = `${slide.title} ${slide.label} ${slide.topic}`.toLowerCase();
      return { slide, score: fw.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.slide.position - b.slide.position)[0]?.slide ?? null;
}

function applyFeedback(plan: PresentationPlan, slides: PresentationDeckSlide[], feedback: string, stepId?: string): { plan: PresentationPlan; warning?: string } {
  const note = feedback.trim();
  const slide = parseSlide(note, slides);
  const explicitIndex = parseStepIndex(note);
  const targetIndex = stepId ? plan.steps.findIndex((s) => s.id === stepId) : explicitIndex ?? 0;
  if (targetIndex < 0 || !plan.steps[targetIndex]) return { plan, warning: "Couldn't find that overview step — nothing was changed." };
  // Fail LOUDLY (not silently) when the coach names a slide we can't match: the step keeps
  // its current slide and the user is told, instead of thinking the anchor changed.
  const mentionsSlide = /\bslide\b/i.test(note);
  const warning = mentionsSlide && !slide ? "That slide couldn't be matched to the approved deck — the step's slide was left unchanged (the note was still saved)." : undefined;

  const next: PresentationPlan = {
    updatedAt: new Date().toISOString(),
    steps: plan.steps.map((step, index) => {
      if (index !== targetIndex) return step;
      const existing = step.instruction.trim();
      const instruction = existing.toLowerCase().includes(note.toLowerCase()) ? existing : [existing, note].filter(Boolean).join("\n");
      return {
        ...step,
        ...(slide ? { slideId: slide.id, title: step.title || slide.title } : {}),
        instruction: instruction.slice(0, 500),
      };
    }),
  };
  return { plan: next, warning };
}

async function saveGuidedOverview(c: Awaited<ReturnType<typeof getContainer>>, plan: PresentationPlan): Promise<PresentationPlan> {
  const studio = c.studio as unknown as {
    setGuidedOverviewPlan?: (aiRepId: typeof c.demo.aiRepId, plan: PresentationPlan) => Promise<{ guidedOverview?: PresentationPlan } | null>;
    states?: { update?: (id: typeof c.demo.aiRepId, patch: { guidedOverview: PresentationPlan }) => Promise<{ guidedOverview?: PresentationPlan } | null> };
  };
  if (typeof studio.setGuidedOverviewPlan === "function") {
    const snap = await studio.setGuidedOverviewPlan(c.demo.aiRepId, plan);
    return snap?.guidedOverview ?? plan;
  }
  // Hot-reload compatibility: an already-running dev server may hold the pre-change
  // StudioService instance. Its repository is still the same source of truth, so update
  // that field directly until the server restarts and the public method exists.
  if (typeof studio.states?.update === "function") {
    const updated = await studio.states.update(c.demo.aiRepId, { guidedOverview: plan });
    return updated?.guidedOverview ?? plan;
  }
  return plan;
}

async function snapshot(): Promise<{ slides: PresentationDeckSlide[]; plan: PresentationPlan }> {
  const c = await getContainer();
  const presentation = new PresentationSkill(c.content);
  const saved = (await c.studio.get(c.demo.aiRepId))?.guidedOverview;
  // The rendered deck is scoped to the skeleton the plan was drafted from — so with multiple decks
  // you present ONE, not all pooled. Unset (single-deck default) → the whole approved ppt deck.
  const assetId = saved?.deckAssetId;
  const slides = await presentation.deck(contextOf(c), { assetId });
  const fallback = await presentation.defaultPlan(contextOf(c), { assetId });
  return { slides, plan: mergePlan(saved, fallback, slides) };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await snapshot());
  } catch (e) {
    // Details stay server-side — raw error messages can leak internals to the client.
    console.error("[presentation/plan]", e);
    return NextResponse.json({ error: "internal error — check server logs", slides: [], plan: { steps: [] } }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      plan?: unknown;
      feedback?: unknown;
      stepId?: unknown;
      /** reset only: draft the script from ONE source document's approved slides. */
      assetId?: unknown;
    };
    const c = await getContainer();
    const presentation = new PresentationSkill(c.content);
    const saved = (await c.studio.get(c.demo.aiRepId))?.guidedOverview;
    // The skeleton deck this presentation is scoped to (reset can change it below). Everything —
    // rendered deck, fallback plan, walkthrough — scopes to this asset; unset → the whole ppt deck.
    let deckAssetId = saved?.deckAssetId;
    let slides = await presentation.deck(contextOf(c), { assetId: deckAssetId });
    let fallback = await presentation.defaultPlan(contextOf(c), { assetId: deckAssetId });
    let plan = mergePlan(saved, fallback, slides);
    let warning: string | undefined;

    if (body.action === "save") {
      const raw = body.plan as Partial<PresentationPlan> | undefined;
      const steps = Array.isArray(raw?.steps) ? raw.steps : [];
      plan = mergePlan({ steps: steps as PresentationPlanStep[], deckAssetId }, fallback, slides);
    } else if (body.action === "applyFeedback") {
      if (typeof body.feedback !== "string" || !body.feedback.trim()) {
        return NextResponse.json({ error: "feedback required" }, { status: 400 });
      }
      // Bounded like every other coaching input (the note lands in a stored instruction).
      const applied = applyFeedback(plan, slides, body.feedback.slice(0, 500), typeof body.stepId === "string" ? body.stepId : undefined);
      plan = { ...applied.plan, ...(deckAssetId ? { deckAssetId } : {}) };
      warning = applied.warning;
    } else if (body.action === "reset") {
      const assetId = typeof body.assetId === "string" && body.assetId.trim() ? body.assetId.trim() : undefined;
      if (assetId) {
        const scoped = await presentation.defaultPlan(contextOf(c), { assetId });
        if (!scoped.steps.length) {
          // Honest refusal: the picked source has no APPROVED slides yet (still in MLR).
          return NextResponse.json({ error: "that source has no approved slides yet — approve its passages in MLR review first", slides, plan }, { status: 409 });
        }
        // Presenting THIS deck: it becomes the skeleton, so the rendered deck scopes to its slides.
        deckAssetId = assetId;
        plan = { ...scoped, deckAssetId };
        slides = await presentation.deck(contextOf(c), { assetId });
      } else {
        // Reset with no asset → clear the skeleton (present the whole approved deck again).
        deckAssetId = undefined;
        fallback = await presentation.defaultPlan(contextOf(c));
        slides = await presentation.deck(contextOf(c));
        plan = fallback;
      }
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    const savedPlan = await saveGuidedOverview(c, plan);
    return NextResponse.json({ slides, plan: savedPlan, ...(warning ? { warning } : {}) });
  } catch (e) {
    // Details stay server-side — raw error messages can leak internals to the client.
    console.error("[presentation/plan]", e);
    return NextResponse.json({ error: "internal error — check server logs", slides: [], plan: { steps: [] } }, { status: 500 });
  }
}
