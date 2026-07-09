/**
 * DocNexus Setup Assistant (brief §5). INTERNAL assistant for the brand user.
 * It asks one setup question at a time and infers structured setup values into
 * editable sections. It must NEVER behave like the HCP-facing rep.
 *
 * This module owns: the setup question script, field inference, and the
 * structured SetupDraft with per-section status. Vendor LLM calls (when added)
 * sit behind this surface — the section/status model does not change.
 */

import { newId, type AiRepId } from "@lib/ids";

export type SectionKey =
  | "profile"
  | "approved_knowledge"
  | "audience"
  | "escalation"
  | "conversation_rules"
  | "readiness";

export type SectionStatus = "complete" | "needs_input" | "needs_source" | "needs_mlr" | "blocked";

export interface SetupField {
  key: string;
  label: string;
  value: string | null; // inferred value, editable; null = not yet inferred
  inferred: boolean;
}

export interface SetupSection {
  key: SectionKey;
  title: string;
  status: SectionStatus;
  fields: SetupField[];
}

export interface SetupDraft {
  aiRepId: AiRepId;
  sections: SetupSection[];
}

/** Ordered setup questions the assistant asks (brief §5.2). One at a time. */
export const SETUP_QUESTIONS: { key: string; section: SectionKey; prompt: string }[] = [
  { key: "brand", section: "profile", prompt: "Which brand or product is this rep for?" },
  { key: "therapeutic_area", section: "profile", prompt: "What therapeutic area?" },
  { key: "indication", section: "profile", prompt: "Which indication should the rep focus on?" },
  { key: "persona_type", section: "profile", prompt: "Brand persona or rep clone?" },
  { key: "target_audience", section: "audience", prompt: "Who is the target audience (specialty, decile/whitespace)?" },
  { key: "approved_content", section: "approved_knowledge", prompt: "What approved content do you have (PPT, PI, ISI, FAQ, script)?" },
  { key: "disclosure", section: "conversation_rules", prompt: "What AI-disclosure text should the rep open with?" },
  { key: "greeting", section: "conversation_rules", prompt: "What is the approved greeting?" },
  { key: "msl_contact", section: "escalation", prompt: "Who is the MSL / medical information contact?" },
  { key: "ae_routing", section: "escalation", prompt: "Where should adverse-event reports route?" },
  { key: "blocked_topics", section: "conversation_rules", prompt: "Any blocked topics?" },
  { key: "talking_points", section: "conversation_rules", prompt: "Required talking points?" },
];

/** Create an empty draft with all sections pending input. Build mode fills it in. */
export function emptyDraft(seed?: string): SetupDraft {
  const sections: SetupSection[] = (
    [
      ["profile", "Rep profile"],
      ["approved_knowledge", "Approved knowledge"],
      ["audience", "Audience"],
      ["escalation", "Escalation & handoff"],
      ["conversation_rules", "Conversation rules"],
      ["readiness", "Readiness"],
    ] as [SectionKey, string][]
  ).map(([key, title]) => ({ key, title, status: "needs_input" as SectionStatus, fields: [] }));

  return { aiRepId: newId<"ai_rep_id">("airep", seed) as AiRepId, sections };
}

/** Apply an answer to the draft: fills the field and recomputes section status. */
export function applyAnswer(draft: SetupDraft, questionKey: string, value: string): SetupDraft {
  const q = SETUP_QUESTIONS.find((x) => x.key === questionKey);
  if (!q) return draft;
  const sections = draft.sections.map((s) => {
    if (s.key !== q.section) return s;
    const fields = upsertField(s.fields, { key: q.key, label: q.prompt, value, inferred: true });
    return { ...s, fields, status: deriveStatus(s.key, fields) };
  });
  return { ...draft, sections };
}

function upsertField(fields: SetupField[], field: SetupField): SetupField[] {
  const idx = fields.findIndex((f) => f.key === field.key);
  if (idx === -1) return [...fields, field];
  const copy = [...fields];
  copy[idx] = field;
  return copy;
}

function deriveStatus(section: SectionKey, fields: SetupField[]): SectionStatus {
  const filled = fields.filter((f) => f.value).length;
  if (filled === 0) return "needs_input";
  // Approved knowledge needs a source + MLR before it can be "complete".
  if (section === "approved_knowledge") return "needs_source";
  return "complete";
}
