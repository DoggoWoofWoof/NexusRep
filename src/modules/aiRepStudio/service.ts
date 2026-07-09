/**
 * StudioService — persistence for the Build/Train lifecycle (brief §5–9).
 *
 * The setup-assistant field inference (@modules/setupAssistant) and rule
 * generation (@modules/rules) are pure functions; this service orchestrates them
 * and PERSISTS the result so a rep's build/training survives refresh and flows
 * into Launch. Repo-backed → Postgres-ready. Compliance-sensitive training rules
 * keep their non-active status here exactly as generated — the studio never
 * bypasses MLR.
 */

import { MemoryRepositoryFactory, type Entity, type Repository, type RepositoryFactory } from "@lib/repository";
import type { AiRepId, BrandId, CampaignId, PersonaId, RuleId } from "@lib/ids";
import { asId, newId } from "@lib/ids";
import { applyAnswer, emptyDraft, type SectionKey, type SectionStatus, type SetupDraft } from "@modules/setupAssistant";
import type { PresentationPlan } from "@modules/content";
import { generateRule, type GenerateRuleInput, type RuleScope, type RuleStatus, type RuleType, type TrainingRule } from "@modules/rules";
import { readiness, type AIRep, type AIRepPersona, type ReadinessItem, type RepState } from "./index";

export interface StudioState extends Entity {
  /** Keyed by the AI rep id. */
  id: AiRepId;
  rep: AIRep;
  draft: SetupDraft;
  rules: TrainingRule[];
  /** Launch state: which HCPs were invited + when (undefined until first launch). */
  activation?: { hcpIds: string[]; launchedAt: string | null };
  /** Trainable guided-overview script: section order + approved slide references. */
  guidedOverview: PresentationPlan;
}

export interface StudioSnapshot extends StudioState {
  readiness: { pct: number; canLaunch: boolean; items: ReadinessItem[] };
}

function readinessItems(state: StudioState): ReadinessItem[] {
  const status = (k: SectionKey) => state.draft.sections.find((s) => s.key === k)?.status;
  const complete = (k: SectionKey) => status(k) === "complete";
  return [
    { key: "profile", label: "Rep profile defined", done: complete("profile"), blocking: true },
    { key: "knowledge", label: "Approved content linked · MLR active", done: complete("approved_knowledge"), blocking: true },
    { key: "audience", label: "Target audience selected", done: complete("audience"), blocking: false },
    { key: "escalation", label: "Escalation routing set", done: complete("escalation"), blocking: true },
    { key: "rules", label: "Conversation rules reviewed", done: complete("conversation_rules"), blocking: false },
  ];
}

function snapshot(state: StudioState): StudioSnapshot {
  const items = readinessItems(state);
  return { ...state, guidedOverview: state.guidedOverview ?? { steps: [], updatedAt: new Date().toISOString() }, readiness: { ...readiness(items), items } };
}

function cleanPlan(plan: PresentationPlan): PresentationPlan {
  const seen = new Set<string>();
  const steps = plan.steps
    .slice(0, 12)
    .map((step, index) => {
      const fallbackId = `overview_step_${index + 1}`;
      const id = /^[a-z0-9_-]{3,80}$/i.test(step.id) ? step.id : fallbackId;
      const safeId = seen.has(id) ? `${id}_${index + 1}` : id;
      seen.add(safeId);
      return {
        id: safeId,
        title: step.title.trim().slice(0, 90) || `Section ${index + 1}`,
        ...(step.slideId?.trim() ? { slideId: step.slideId.trim().slice(0, 120) } : {}),
        instruction: step.instruction.trim().slice(0, 500),
      };
    })
    .filter((step) => step.title || step.slideId || step.instruction);
  return { steps, updatedAt: new Date().toISOString() };
}

/** Two coaching rules carry the same intent (dedup key) — same type, topic, and feedback. */
function sameRule(a: TrainingRule, b: TrainingRule): boolean {
  const norm = (s?: string) => (s ?? "").trim().toLowerCase();
  return (
    a.origin === "coaching" && b.origin === "coaching" &&
    a.type === b.type &&
    // Same wording for DIFFERENT doctors (or scopes) is two distinct rules — the dedup
    // previously collapsed them, silently dropping the second doctor's coaching.
    a.scope === b.scope &&
    norm(a.appliesToHcpId) === norm(b.appliesToHcpId) &&
    norm(a.topic) === norm(b.topic) &&
    norm(a.sourceFeedback) === norm(b.sourceFeedback)
  );
}

export class StudioService {
  private readonly states: Repository<StudioState>;

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.states = repos.create<StudioState>("studio");
  }

  /** Ensure a state exists for a rep, creating a fresh draft if needed. */
  async getOrCreate(input: { aiRepId: AiRepId; brandId: BrandId; campaignId: CampaignId; persona?: AIRepPersona }): Promise<StudioSnapshot> {
    const existing = await this.states.get(input.aiRepId);
    if (existing) return snapshot(existing);
    const persona: AIRepPersona = input.persona ?? {
      id: asId<"persona_id">(`persona_${input.aiRepId}`) as PersonaId,
      type: "brand_persona",
      displayName: "AI Specialist",
      voiceStyle: "warm",
      disclosureText: "I'm an AI representative. I can share approved information and connect you with a person when needed.",
      greeting: "Hello — I'm here to share approved information. How can I help?",
    };
    const state: StudioState = {
      id: input.aiRepId,
      rep: { id: input.aiRepId, brandId: input.brandId, campaignId: input.campaignId, persona, state: "draft" },
      draft: emptyDraft(input.aiRepId),
      rules: [],
      guidedOverview: { steps: [], updatedAt: new Date().toISOString() },
    };
    await this.states.insert(state);
    return snapshot(state);
  }

  async get(aiRepId: AiRepId): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    return s ? snapshot(s) : null;
  }

  async setGuidedOverviewPlan(aiRepId: AiRepId, plan: PresentationPlan): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const updated = await this.states.update(aiRepId, { guidedOverview: cleanPlan(plan) });
    return updated ? snapshot(updated) : null;
  }

  /**
   * Persist the Launch activation: which HCPs were invited and when. This is REAL,
   * durable state (survives navigation/restart) — the Launch screen derives each
   * doctor's shareable /hcp?hcp=<id> link from it. Fails safe: cannot launch unready.
   */
  async launch(aiRepId: AiRepId, hcpIds: string[]): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    if (!snapshot(s).readiness.canLaunch) return snapshot(s);
    const unique = Array.from(new Set(hcpIds.map((h) => h.trim()).filter(Boolean))).slice(0, 500);
    if (!unique.length) return snapshot(s);
    const updated = await this.states.update(aiRepId, { activation: { hcpIds: unique, launchedAt: new Date().toISOString() } });
    return updated ? snapshot(updated) : null;
  }

  /** Apply a setup answer and persist. Some keys also drive BEHAVIOR (not just the draft). */
  async answer(aiRepId: AiRepId, questionKey: string, value: string): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    // voice_style is persona config, not just a draft field.
    const styles = ["professional", "warm", "clinical"] as const;
    const style = questionKey === "voice_style" ? styles.find((v) => value.toLowerCase().includes(v)) : undefined;
    const rep = style ? { ...s.rep, persona: { ...s.rep.persona, voiceStyle: style } } : s.rep;
    const updated = await this.states.update(aiRepId, { draft: applyAnswer(s.draft, questionKey, value), rep });
    // blocked_topics from setup become ACTIVE brand guardrails (enforced by steering at
    // runtime) — previously the answer was stored but nothing ever consumed it.
    if (questionKey === "blocked_topics" && updated) {
      let snap: StudioSnapshot | null = snapshot(updated);
      for (const topic of value.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean).slice(0, 20)) {
        snap =
          (await this.addGuardrail(aiRepId, {
            type: "blocked_topic",
            scope: "campaign",
            topic,
            instruction: `Do not raise "${topic}" — blocked in brand setup; route to Medical Information.`,
            seed: `grd_setup_blocked_${topic.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          })) ?? snap;
      }
      return snap;
    }
    return updated ? snapshot(updated) : null;
  }

  /**
   * Link approved content / record MLR sign-off for a section. This is the
   * gated step that lets approved_knowledge reach "complete" — it never happens
   * as a side effect of a free-text answer.
   */
  async setSectionStatus(aiRepId: AiRepId, section: SectionKey, status: SectionStatus): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const draft: SetupDraft = { ...s.draft, sections: s.draft.sections.map((sec) => (sec.key === section ? { ...sec, status } : sec)) };
    const updated = await this.states.update(aiRepId, { draft });
    return updated ? snapshot(updated) : null;
  }

  /** Turn coaching feedback into a persisted (compliance-aware) draft rule. */
  async addRule(aiRepId: AiRepId, input: GenerateRuleInput): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const rule = generateRule(input);
    // Dedup by id (seeded/deterministic) AND by content — coaching rules get a fresh id
    // each time, so without a content check, re-coaching the SAME thing piles up duplicates.
    if (s.rules.some((r) => r.id === rule.id || sameRule(r, rule))) return snapshot(s);
    const updated = await this.states.update(aiRepId, { rules: [...s.rules, rule] });
    return updated ? snapshot(updated) : null;
  }

  /**
   * Add a persona_style coaching rule with an EXPLICIT (already-compacted) instruction — used when
   * the accept step has summarized several style notes into one directive + example. Kept as a
   * DRAFT (persona_style is never compliance-sensitive), so it still needs review before going live.
   */
  async addStyleRule(
    aiRepId: AiRepId,
    input: { instruction: string; sourceFeedback: string; scope?: RuleScope; appliesToHcpId?: string; sourceMessage?: string; seed?: string },
  ): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const rule: TrainingRule = {
      id: newId<"rule_id">("rule", input.seed) as RuleId,
      type: "persona_style",
      scope: input.scope ?? (input.appliesToHcpId ? "hcp_specific" : "persona"),
      status: "draft",
      instruction: input.instruction,
      sourceFeedback: input.sourceFeedback,
      appliesToHcpId: input.appliesToHcpId,
      origin: "coaching",
      sourceMessage: input.sourceMessage,
    };
    if (s.rules.some((r) => r.id === rule.id || sameRule(r, rule))) return snapshot(s);
    const updated = await this.states.update(aiRepId, { rules: [...s.rules, rule] });
    return updated ? snapshot(updated) : null;
  }

  /**
   * Persist an accepted coaching session: compliance-SENSITIVE notes each become their own gated
   * rule (unchanged classification), and the STYLE notes are saved as ONE compacted style rule
   * (with the accepted answer as an example). This is how "accept" turns a whole coaching thread
   * into rules without collapsing a gated note into an ungated one.
   */
  async acceptCoaching(
    aiRepId: AiRepId,
    input: { sensitive: string[]; style: string[]; compactedInstruction?: string; scope?: RuleScope; appliesToHcpId?: string; sourceMessage?: string },
  ): Promise<StudioSnapshot | null> {
    let snap = await this.get(aiRepId);
    if (!snap) return null;
    for (const note of input.sensitive) {
      snap = (await this.addRule(aiRepId, { feedback: note, scope: input.scope, appliesToHcpId: input.appliesToHcpId, sourceMessage: input.sourceMessage })) ?? snap;
    }
    if (input.style.length && input.compactedInstruction) {
      snap = (await this.addStyleRule(aiRepId, {
        instruction: input.compactedInstruction,
        sourceFeedback: input.style.join(" / "),
        scope: input.scope,
        appliesToHcpId: input.appliesToHcpId,
        sourceMessage: input.sourceMessage,
      })) ?? snap;
    }
    return snap;
  }

  /** Collapse duplicate coaching rules (same type/topic/feedback), keeping the first. */
  async dedupeRules(aiRepId: AiRepId): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const kept: TrainingRule[] = [];
    for (const r of s.rules) if (!kept.some((k) => k.id === r.id || sameRule(k, r))) kept.push(r);
    if (kept.length === s.rules.length) return snapshot(s);
    const updated = await this.states.update(aiRepId, { rules: kept });
    return updated ? snapshot(updated) : null;
  }

  /** Seed a locked compliance guardrail (active, not coaching-derived). */
  async addGuardrail(
    aiRepId: AiRepId,
    input: { type: RuleType; scope: RuleScope; instruction: string; appliesToHcpId?: string; topic?: string; seed?: string },
  ): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const rule: TrainingRule = {
      id: newId<"rule_id">("rule", input.seed) as RuleId,
      type: input.type,
      scope: input.scope,
      status: "active",
      instruction: input.instruction,
      sourceFeedback: "",
      appliesToHcpId: input.appliesToHcpId,
      // A concrete topic makes the guardrail ENFORCEABLE by runtime steering
      // (blocked_topic reroutes to Medical Information), not just advisory text.
      ...(input.topic ? { topic: input.topic } : {}),
      origin: "guardrail",
    };
    // Idempotent for seeded guardrails (deterministic ids): no duplicates on restart.
    if (s.rules.some((r) => r.id === rule.id)) return snapshot(s);
    const updated = await this.states.update(aiRepId, { rules: [...s.rules, rule] });
    return updated ? snapshot(updated) : null;
  }

  async setRuleStatus(aiRepId: AiRepId, ruleId: string, status: RuleStatus): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    const rules = s.rules.map((r) => (r.id === ruleId ? { ...r, status } : r));
    const updated = await this.states.update(aiRepId, { rules });
    return updated ? snapshot(updated) : null;
  }

  /** Transition rep state (draft → in_review → ready → live). Launch requires canLaunch. */
  async setRepState(aiRepId: AiRepId, next: RepState): Promise<StudioSnapshot | null> {
    const s = await this.states.get(aiRepId);
    if (!s) return null;
    if (next === "live" && !snapshot(s).readiness.canLaunch) return snapshot(s); // fail safe: cannot launch unready
    const updated = await this.states.update(aiRepId, { rep: { ...s.rep, state: next } });
    return updated ? snapshot(updated) : null;
  }
}
