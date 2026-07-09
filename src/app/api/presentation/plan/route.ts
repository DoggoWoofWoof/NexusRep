/**
 * Guided-overview plan controller. The plan is the trainable script structure:
 * ordered sections, each anchored to an approved detail-aid slide. The spoken
 * medical body still comes from the approved content block for that slide.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { PresentationSkill, type PresentationDeckSlide, type PresentationPlan, type PresentationPlanStep } from "@modules/content";

export const dynamic = "force-dynamic";

function contextOf(c: Awaited<ReturnType<typeof getContainer>>) {
  return { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market };
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

function mergePlan(saved: PresentationPlan | undefined, fallback: PresentationPlan, slides: PresentationDeckSlide[]): PresentationPlan {
  const base = saved?.steps?.length ? saved : fallback;
  const fallbackByIndex = fallback.steps;
  return {
    updatedAt: base.updatedAt ?? fallback.updatedAt,
    steps: base.steps.map((step, index) => cleanStep(step, fallbackByIndex[index] ?? fallback.steps[0]!, slides, index)),
  };
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
  const mentionsSlide = /slide/i.test(note);
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
  const slides = await presentation.deck(contextOf(c));
  const fallback = await presentation.defaultPlan(contextOf(c));
  const saved = (await c.studio.get(c.demo.aiRepId))?.guidedOverview;
  return { slides, plan: mergePlan(saved, fallback, slides) };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await snapshot());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), slides: [], plan: { steps: [] } }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      plan?: unknown;
      feedback?: unknown;
      stepId?: unknown;
    };
    const c = await getContainer();
    const presentation = new PresentationSkill(c.content);
    const slides = await presentation.deck(contextOf(c));
    const fallback = await presentation.defaultPlan(contextOf(c));
    const saved = (await c.studio.get(c.demo.aiRepId))?.guidedOverview;
    let plan = mergePlan(saved, fallback, slides);
    let warning: string | undefined;

    if (body.action === "save") {
      const raw = body.plan as Partial<PresentationPlan> | undefined;
      const steps = Array.isArray(raw?.steps) ? raw.steps : [];
      plan = mergePlan({ steps: steps as PresentationPlanStep[] }, fallback, slides);
    } else if (body.action === "applyFeedback") {
      if (typeof body.feedback !== "string" || !body.feedback.trim()) {
        return NextResponse.json({ error: "feedback required" }, { status: 400 });
      }
      const applied = applyFeedback(plan, slides, body.feedback, typeof body.stepId === "string" ? body.stepId : undefined);
      plan = applied.plan;
      warning = applied.warning;
    } else if (body.action === "reset") {
      plan = fallback;
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    const savedPlan = await saveGuidedOverview(c, plan);
    return NextResponse.json({ slides, plan: savedPlan, ...(warning ? { warning } : {}) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), slides: [], plan: { steps: [] } }, { status: 500 });
  }
}
