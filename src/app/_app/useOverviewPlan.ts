"use client";

import { useEffect, useState } from "react";
import type { OverviewPlanSnap, OverviewPlanStep } from "./studio-types";

export function useOverviewPlan() {
  const [overviewPlan, setOverviewPlan] = useState<OverviewPlanSnap | null>(null);
  const [activePlanStepId, setActivePlanStepId] = useState("");
  const [planNote, setPlanNote] = useState("");
  const [planMsg, setPlanMsg] = useState("");
  const [planSaving, setPlanSaving] = useState(false);

  const loadOverviewPlan = async () => {
    try {
      const res = await fetch("/api/presentation/plan");
      if (!res.ok) return;
      const data = (await res.json()) as OverviewPlanSnap;
      setOverviewPlan(data);
      setActivePlanStepId((current) => current || data.plan.steps[0]?.id || "");
    } catch {
      /* deck editor is progressive; coaching still works without it */
    }
  };

  useEffect(() => {
    void loadOverviewPlan();

  }, []);

  const persistOverviewPlan = async (plan = overviewPlan?.plan, message = "Script saved.") => {
    if (!plan) return;
    setPlanSaving(true);
    setPlanMsg("Saving script…");
    try {
      const res = await fetch("/api/presentation/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", plan }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as OverviewPlanSnap;
      setOverviewPlan(data);
      setActivePlanStepId((current) => data.plan.steps.some((s) => s.id === current) ? current : data.plan.steps[0]?.id || "");
      setPlanMsg(message);
    } catch (e) {
      setPlanMsg(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPlanSaving(false);
    }
  };

  const updatePlanStep = (stepId: string, patch: Partial<OverviewPlanStep>, save = false) => {
    if (!overviewPlan) return;
    const nextPlan = { ...overviewPlan.plan, steps: overviewPlan.plan.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) };
    setOverviewPlan({ ...overviewPlan, plan: nextPlan });
    if (save) void persistOverviewPlan(nextPlan, "Script section saved.");
  };

  const applyPlanNote = async (feedback = planNote, stepId = activePlanStepId) => {
    const note = feedback.trim();
    if (!note) return;
    setPlanMsg("Applying your note to the script…");
    try {
      const res = await fetch("/api/presentation/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "applyFeedback", feedback: note, stepId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as OverviewPlanSnap & { warning?: string };
      setOverviewPlan(data);
      setActivePlanStepId(stepId || data.plan.steps[0]?.id || "");
      setPlanNote("");
      // Surface server-side warnings (e.g. a named slide couldn't be matched) instead of
      // silently pretending the anchor changed.
      setPlanMsg(data.warning ? `⚠ ${data.warning}` : "Script updated — rehearsals and every doctor conversation use it.");
    } catch (e) {
      setPlanMsg(`Could not apply note: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Reorder script sections — guarded while a save is in flight: two rapid moves could
  // otherwise interleave and the first server response would briefly clobber the second.
  const movePlanStep = (stepId: string, dir: -1 | 1) => {
    if (!overviewPlan || planSaving) return;
    const steps = [...overviewPlan.plan.steps];
    const i = steps.findIndex((st) => st.id === stepId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    const nextPlan = { ...overviewPlan.plan, steps };
    setOverviewPlan({ ...overviewPlan, plan: nextPlan });
    void persistOverviewPlan(nextPlan, "Script order updated — the rep now presents in this order.");
  };

  /** Re-draft the script from the approved deck — optionally from ONE source document. */
  const resetOverviewPlan = async (assetId?: string) => {
    setPlanMsg(assetId ? "Drafting the script from that source…" : "Re-drafting from the full approved deck…");
    try {
      const res = await fetch("/api/presentation/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset", ...(assetId ? { assetId } : {}) }) });
      const data = (await res.json()) as OverviewPlanSnap & { error?: string };
      if (!res.ok) throw new Error(data.error ?? String(res.status));
      setOverviewPlan(data);
      setActivePlanStepId(data.plan.steps[0]?.id || "");
      setPlanMsg(assetId ? "Script drafted from the selected source." : "Reset to approved deck order.");
    } catch (e) {
      setPlanMsg(`Could not draft: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const activePlanStep = overviewPlan?.plan.steps.find((s) => s.id === activePlanStepId) ?? overviewPlan?.plan.steps[0];
  const activePlanSlideId = activePlanStep?.slideId ?? overviewPlan?.slides[0]?.id;

  return {
    overviewPlan, activePlanStepId, setActivePlanStepId, activePlanSlideId,
    planNote, setPlanNote, planMsg, planSaving,
    loadOverviewPlan, persistOverviewPlan, updatePlanStep, applyPlanNote, movePlanStep, resetOverviewPlan,
  };
}
