/**
 * Shared Studio types used by the Studio screen and its extracted hook/cards. Kept in a dependency-free
 * module so the hook (useOverviewPlan) and the plan card can live in their own files without importing
 * back from StudioScreen (which would be circular).
 */

/** One selectable slide the guided-overview script can anchor a step to. */
export interface OverviewSlideOption {
  id: string;
  title: string;
  label: string;
  position: number;
  sourceId: string;
  topic: string;
  preview: string;
}

/** One step (section) of the guided-overview script. */
export interface OverviewPlanStep {
  id: string;
  title: string;
  slideId?: string;
  instruction: string;
}

/** The guided-overview plan snapshot returned by /api/presentation/plan. */
export interface OverviewPlanSnap {
  slides: OverviewSlideOption[];
  plan: { steps: OverviewPlanStep[]; updatedAt?: string };
}
