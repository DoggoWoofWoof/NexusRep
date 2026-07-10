/**
 * Pitch coherence: the Brand-pitch card, the Train rehearsal, and the doctor-facing
 * delivery must all follow the SAME effective plan — and doctor-view "Try asking"
 * suggestions derive from the live approved knowledge, not a static list.
 */
import { describe, expect, it } from "vitest";
import { tryQuestionsFromKnowledge } from "../src/modules/brand";
import { mergePlan, type PresentationDeckSlide, type PresentationPlan } from "../src/modules/content";

const SLIDES: PresentationDeckSlide[] = [
  { id: "slide_a", title: "Alpha", label: "Slide 1", position: 1, sourceId: "ans_a", topic: "overview", preview: "a" },
  { id: "slide_b", title: "Beta", label: "Slide 2", position: 2, sourceId: "ans_b", topic: "mechanism", preview: "b" },
];

const FALLBACK: PresentationPlan = {
  steps: [
    { id: "overview_step_1", title: "Alpha", slideId: "slide_a", instruction: "open" },
    { id: "overview_step_2", title: "Beta", slideId: "slide_b", instruction: "continue" },
  ],
};

describe("mergePlan (single source of truth for the pitch)", () => {
  it("returns the default plan when nothing is saved", () => {
    const plan = mergePlan(undefined, FALLBACK, SLIDES);
    expect(plan.steps.map((s) => s.id)).toEqual(["overview_step_1", "overview_step_2"]);
  });

  it("keeps the saved order and titles (what the card shows is what the rep speaks)", () => {
    const saved: PresentationPlan = {
      steps: [
        { id: "overview_step_2", title: "Beta first", slideId: "slide_b", instruction: "lead with beta" },
        { id: "overview_step_1", title: "Alpha", slideId: "slide_a", instruction: "then alpha" },
      ],
    };
    const plan = mergePlan(saved, FALLBACK, SLIDES);
    expect(plan.steps.map((s) => s.slideId)).toEqual(["slide_b", "slide_a"]);
    expect(plan.steps[0]!.title).toBe("Beta first");
  });

  it("sanitizes a saved slide that no longer exists in the approved deck", () => {
    const saved: PresentationPlan = {
      steps: [{ id: "overview_step_1", title: "Alpha", slideId: "slide_deleted", instruction: "open" }],
    };
    const plan = mergePlan(saved, FALLBACK, SLIDES);
    expect(plan.steps[0]!.slideId).toBe("slide_a"); // falls back to the default anchor
  });
});

describe("tryQuestionsFromKnowledge (doctor suggestions from live content)", () => {
  it("maps known topics to natural questions", () => {
    const qs = tryQuestionsFromKnowledge(["overview", "mechanism", "trial_data", "safety"], "Milvexian");
    expect(qs).toContain("How does Milvexian work?");
    expect(qs).toContain("What is the clinical program studying?");
    expect(qs).toContain("What safety information should I be aware of?");
    expect(qs.join(" ")).not.toMatch(/overview/i); // the pitch covers the overview
  });

  it("phrases unknown topics generically (uploads with novel topics still suggest well)", () => {
    const qs = tryQuestionsFromKnowledge(["reimbursement_pathways"], "Zephyrotest");
    expect(qs[0]).toBe("What does the approved information cover on reimbursement pathways?");
  });

  it("dedupes and caps the list", () => {
    const qs = tryQuestionsFromKnowledge(["mechanism", "moa", "dosing", "safety", "status", "access"], "X", 4);
    expect(qs.length).toBe(4);
    expect(new Set(qs).size).toBe(4);
  });

  it("returns nothing for empty knowledge (caller falls back to the profile)", () => {
    expect(tryQuestionsFromKnowledge([], "X")).toEqual([]);
  });
});
