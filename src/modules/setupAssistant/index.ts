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
  { key: "specialty", section: "audience", prompt: "Which specialty is in scope?" },
  { key: "approved_content", section: "approved_knowledge", prompt: "What approved content do you have (PPT, PI, ISI, FAQ, script)?" },
  { key: "disclosure", section: "conversation_rules", prompt: "What AI-disclosure text should the rep open with?" },
  { key: "greeting", section: "conversation_rules", prompt: "What is the approved greeting?" },
  { key: "msl_contact", section: "escalation", prompt: "Who is the MSL / medical information contact?" },
  { key: "ae_routing", section: "escalation", prompt: "Where should adverse-event reports route?" },
  { key: "blocked_topics", section: "conversation_rules", prompt: "Any blocked topics?" },
  { key: "talking_points", section: "conversation_rules", prompt: "Required talking points?" },
  // Everything below is optional polish — chatable so no brand copy lives in code.
  { key: "sponsor", section: "profile", prompt: "Sponsor / company name shown to doctors?" },
  { key: "tagline", section: "profile", prompt: "One-line product descriptor for HCP outreach?" },
  { key: "voice_style", section: "profile", prompt: "Rep voice tone (professional / warm / clinical)?" },
  { key: "try_questions", section: "conversation_rules", prompt: "Suggested sample questions to offer doctors (comma-separated)?" },
  { key: "hotwords", section: "conversation_rules", prompt: "Product & competitor names to bias speech recognition (comma-separated)?" },
];

/** Result of document-driven setup inference: what got filled, what stayed untouched. */
export interface InferredSetup {
  filled: Record<string, string>;
  skipped: string[];
}

const INFERABLE_KEYS = ["brand", "indication", "therapeutic_area", "sponsor", "tagline", "talking_points", "hotwords", "try_questions"] as const;

/**
 * Infer setup answers from an uploaded document (deck/PI/FAQ text) so the brand user
 * doesn't answer every question by hand — upload once, review the drafted sections.
 * An LLM extracts structured fields when available (strict JSON, sanitized); a light
 * deterministic fallback still fills the obvious ones offline. NEVER overwrites an
 * answer the user already gave — inference only fills blanks.
 */
export async function inferSetupAnswersFromDocument(
  docText: string,
  existing: Record<string, string | null | undefined>,
  llm?: (system: string, user: string) => Promise<string | null>,
): Promise<InferredSetup> {
  const open = INFERABLE_KEYS.filter((k) => !(existing[k] ?? "").toString().trim());
  if (!open.length || !docText.trim()) return { filled: {}, skipped: [...INFERABLE_KEYS] };

  const doc = docText.slice(0, 6000);
  let candidates: Record<string, string> = {};

  if (llm) {
    const system = `You extract pharma-brand setup fields from an approved document. Reply with STRICT JSON only (no prose, no markdown fences) with these keys — use "" when the document doesn't say:
{"brand": "product name", "indication": "primary indication", "therapeutic_area": "e.g. cardiology", "sponsor": "company name(s)", "tagline": "one neutral line describing the product (non-promotional)", "talking_points": "3-5 comma-separated topic labels covered by the document", "hotwords": "comma-separated product/program/competitor proper nouns", "try_questions": "2-4 semicolon-separated questions a doctor might ask that this document answers"}`;
    const raw = await llm(system, `Document:\n"""${doc}"""`).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim()) as Record<string, unknown>;
        for (const k of INFERABLE_KEYS) {
          const v = parsed[k];
          if (typeof v === "string" && v.trim()) candidates[k] = v.trim().slice(0, 300);
        }
      } catch {
        candidates = {};
      }
    }
  }

  // Deterministic fallback for the basics (offline / LLM unavailable): the most repeated
  // capitalized token is almost always the product name in a product document.
  if (!candidates.brand) {
    const counts = new Map<string, number>();
    for (const m of doc.matchAll(/\b[A-Z][a-z]{4,}\b/g)) {
      const w = m[0];
      if (/^(The|This|These|Those|Please|Important|Safety|Information|Medical|Phase|Program|About)$/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3) candidates.brand = top[0];
  }

  const filled: Record<string, string> = {};
  for (const k of open) if (candidates[k]) filled[k] = candidates[k];
  return { filled, skipped: INFERABLE_KEYS.filter((k) => !(k in filled)) };
}

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
