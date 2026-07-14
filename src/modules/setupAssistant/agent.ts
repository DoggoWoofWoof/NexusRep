/**
 * DocNexus Setup Assistant — the AGENTIC brain (brief §5). This is the INTERNAL assistant that
 * talks to the BRAND user while they build their AI rep. It understands free-form instructions
 * ("here's our deck, use it", "focus this on AFib in cardiologists", "never let it discuss dosing")
 * and turns them into concrete, reviewable actions.
 *
 * PROPOSE-then-CONFIRM: the agent never mutates setup on its own. It replies in plain language and
 * emits a list of PROPOSED actions; the caller executes them only after the brand user confirms.
 * That keeps a human checkpoint on every consequential change — the right default for a compliance
 * product — and means this module never needs write access to content/studio state.
 *
 * Hard boundaries (it is NOT the HCP-facing rep):
 *  - It talks to the brand user, never to a doctor: no ISI, no disclosures, no medical answers.
 *  - Uploaded documents are ingested for MLR REVIEW — never made live/spoken. It must never imply
 *    an uploaded doc is instantly usable by the rep.
 *  - It never guesses diagnosis/ICD codes (those are resolved from plain-language conditions, not
 *    invented) and only ever proposes setting the curated fields below.
 */

/** A setup field the assistant may propose filling, with the human label shown on the confirm chip.
 *  Deliberately excludes diagnosis_codes: codes are resolved from conditions, never AI-guessed. */
export const SETTABLE_FIELDS: { key: string; label: string }[] = [
  { key: "brand", label: "Brand / product" },
  { key: "therapeutic_area", label: "Therapeutic area" },
  { key: "indication", label: "Indication focus" },
  { key: "sponsor", label: "Sponsor / company" },
  { key: "tagline", label: "Product tagline" },
  { key: "target_specialties", label: "Target specialties" },
  { key: "voice_style", label: "Rep voice tone" },
  { key: "greeting", label: "Approved greeting" },
  { key: "disclosure", label: "AI-disclosure line" },
  { key: "talking_points", label: "Required talking points" },
  { key: "try_questions", label: "Sample doctor questions" },
  { key: "hotwords", label: "Speech-recognition hotwords" },
  { key: "msl_contact", label: "MSL / Medical Info contact" },
  { key: "ae_routing", label: "Adverse-event routing" },
];
const SETTABLE_KEYS = new Set(SETTABLE_FIELDS.map((f) => f.key));
const FIELD_LABEL = new Map(SETTABLE_FIELDS.map((f) => [f.key, f.label]));

export type SetupActionType = "ingest_document" | "set_field" | "draft_rule" | "flag_isi" | "request_upload";

/** One proposed action, awaiting the brand user's confirmation before the caller executes it. */
export interface SetupProposedAction {
  type: SetupActionType;
  /** Humanlike one-liner shown on the confirm chip, e.g. "Ingest “Milvexian MoA.pptx” for MLR review". */
  summary: string;
  /** set_field */
  fieldKey?: string;
  value?: string;
  /** draft_rule — a natural-language instruction; the rules engine gates/scopes it downstream. */
  ruleFeedback?: string;
  ruleScope?: "persona" | "global";
}

export interface SetupTurnResult {
  reply: string;
  actions: SetupProposedAction[];
}

export interface SetupTurnInput {
  message: string;
  history?: { role: "user" | "assistant"; text: string }[];
  /** Non-null when the brand user attached a document THIS turn (already parsed to text upstream).
   *  The agent may propose ingesting it; it never ingests on its own. */
  attachment?: { name: string; text: string } | null;
  /** Current known setup values (blank/absent = not yet set) so the agent neither re-asks nor
   *  proposes overwriting something the user already provided. */
  known?: Record<string, string | null | undefined>;
  /** Whether an approved ISI already exists — lets the agent proactively flag a missing one. */
  hasIsi?: boolean;
}

const MAX_DOC_CHARS = 4000;

const SYSTEM = `You are the DocNexus Setup Assistant — an expert, friendly colleague who helps a pharma brand team build and configure their compliant AI rep. You are talking to the BRAND USER, never to a doctor.

You are aware of your role and the current setup state (given below): which fields are filled, whether an approved ISI exists, and what a document you were given contains. You EXTRACT setup answers from uploaded documents to fill the sections, you keep track of progress, and you can report — whenever asked — what's filled, what's still open, and whether the rep is ready to launch.

Your job: understand what the user wants in plain language and propose concrete setup actions, OR just answer their question about the setup. Be warm, concise, and human — like a sharp teammate, not a form or a script. 1-3 sentences. Never use canned filler ("I'll set up your AI rep. Answer a few questions."). Acknowledge what they said, then propose the next useful step. If they ask what's filled / what's left / how it's going, answer from the state below and name the still-open essentials and the ISI status — no action needed, just tell them.

You do NOT perform actions directly. You PROPOSE them and the user confirms. So phrase things as offers ("I can ingest this deck for review — want me to?"), never as done deals ("I've added it").

You can propose these actions (only these):
- ingest_document: pull an attached document into the approved-content library FOR MLR REVIEW. Only when a document is attached this turn. It is NOT live or spoken until a human reviewer approves it — never imply otherwise.
- set_field: fill one setup field. Allowed keys ONLY: ${SETTABLE_FIELDS.map((f) => f.key).join(", ")}. Never invent keys. Never propose diagnosis/ICD codes. If a field is already set (see "Already set" below), only propose changing it when the user is clearly asking to change it; never re-propose a value identical to the current one.
- draft_rule: draft a conversation rule from an instruction like "never discuss dosing" or "always mention the LIBREXIA program". Give ruleFeedback (the instruction) and ruleScope ("persona" for this rep, "global" for all reps; default persona).
- flag_isi: remind the user an approved Important Safety Information statement is required before launch. Only when none exists yet.
- request_upload: ask the user to upload a document (deck / PI / ISI / FAQ / script) when you need source content and none is attached.

Compliance boundaries you must respect:
- You are the internal setup assistant, NOT the HCP-facing rep: never write ISI, disclosures, or medical answers.
- Uploaded content is for MLR review only; approved content is the single source of truth for the rep.
- Only propose set_field for the allowed keys; leave diagnosis codes to the resolver.

Respond with STRICT JSON only — no prose, no markdown fences:
{"reply": "your short human message", "actions": [{"type": "...", "summary": "...", "fieldKey": "...", "value": "...", "ruleFeedback": "...", "ruleScope": "persona|global"}]}
Include only the fields each action needs. Use an empty actions array when you're just talking or asking a question.`;

function parseFirstJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isSet(known: SetupTurnInput["known"], key: string): boolean {
  return Boolean((known?.[key] ?? "").toString().trim());
}

/**
 * Sanitize the model's proposed actions against the hard rules, dropping anything unsafe or
 * redundant. This is the deterministic backstop: even if the prompt is ignored, an invalid field
 * key, an ingest with no attachment, an ISI flag when one exists, or an overwrite of a user answer
 * can never slip through.
 */
function sanitizeActions(raw: unknown, input: SetupTurnInput): SetupProposedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: SetupProposedAction[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const type = str(a.type) as SetupActionType;
    switch (type) {
      case "ingest_document": {
        if (!input.attachment) break; // can't ingest a doc that isn't here
        const name = input.attachment.name;
        out.push({ type, summary: str(a.summary) || `Ingest “${name}” for MLR review` });
        break;
      }
      case "set_field": {
        const fieldKey = str(a.fieldKey);
        const value = str(a.value);
        if (!SETTABLE_KEYS.has(fieldKey) || !value) break; // unknown/blank → drop
        const current = str(input.known?.[fieldKey]);
        if (current && current.toLowerCase() === value.toLowerCase()) break; // no-op — already this value
        if (seen.has(`f:${fieldKey}`)) break;
        seen.add(`f:${fieldKey}`);
        out.push({ type, fieldKey, value, summary: str(a.summary) || `Set ${FIELD_LABEL.get(fieldKey) ?? fieldKey} → ${value}` });
        break;
      }
      case "draft_rule": {
        const ruleFeedback = str(a.ruleFeedback) || str(a.value);
        if (!ruleFeedback) break;
        const ruleScope = str(a.ruleScope) === "global" ? "global" : "persona";
        out.push({ type, ruleFeedback, ruleScope, summary: str(a.summary) || `Draft rule: ${ruleFeedback}` });
        break;
      }
      case "flag_isi": {
        if (input.hasIsi) break; // don't nag when one already exists
        if (seen.has("isi")) break;
        seen.add("isi");
        out.push({ type, summary: str(a.summary) || "An approved ISI is required before launch — add or confirm one" });
        break;
      }
      case "request_upload": {
        if (input.attachment) break; // pointless when a doc is already attached
        out.push({ type, summary: str(a.summary) || "Upload a deck / PI / ISI / FAQ so I can build from it" });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Pull a brand/product rename out of an explicit instruction ("rename the product to X", "call it
 *  X", "the brand is X") so the assistant can act on the single most common setup edit even without
 *  an LLM. Deliberately narrow — richer field inference is the model's job on the LLM path. */
function heuristicFieldActions(message: string, known: SetupTurnInput["known"]): SetupProposedAction[] {
  const m = message.match(/\b(?:rename(?:\s+(?:it|this|the brand|the product))?\s+to|call it|name it|the (?:brand|product)(?:\s+name)?\s+is|it'?s called)\s+["']?([A-Za-z0-9][\w .&+-]{1,40})/i);
  if (!m) return [];
  const value = m[1]!.trim().replace(/["'.,;:!?]+$/g, "").trim();
  if (!value) return [];
  const current = (known?.brand ?? "").toString().trim();
  if (current && current.toLowerCase() === value.toLowerCase()) return [];
  return [{ type: "set_field", fieldKey: "brand", value, summary: `Set ${FIELD_LABEL.get("brand")} → ${value}` }];
}

const PROGRESS_RE = /\b(?:what(?:'?s| is| have you| did you| do you have)?\s+(?:filled|set|done|configured|left|missing|got)|progress|status|summary|recap|where are we|how (?:far|much|is (?:it|setup)|are we)|ready to launch|what'?s? left|what do you have)\b/i;

/** Report current setup progress in plain language — what's filled, what essentials are still open,
 *  and the ISI status — so the assistant can answer "what have you got so far?" without an LLM. */
function describeProgress(known: SetupTurnInput["known"], hasIsi?: boolean): string {
  const set = SETTABLE_FIELDS.filter((f) => isSet(known, f.key));
  const setList = set.length ? set.map((f) => `${f.label} (${str(known?.[f.key])})`).join(", ") : "nothing yet";
  const missing = ["brand", "indication", "target_specialties"].filter((k) => !isSet(known, k)).map((k) => FIELD_LABEL.get(k) ?? k);
  const bits = [`So far I have ${setList}.`];
  if (missing.length) bits.push(`Still open: ${missing.join(", ")}.`);
  bits.push(hasIsi ? "An approved ISI is in place." : "No approved ISI yet — required before launch.");
  return bits.join(" ");
}

/** A useful, humanlike turn WITHOUT an LLM (offline, no key, or a parse failure). Deterministic so
 *  the assistant is never dead — it recognizes the highest-value intents from keywords/patterns. */
function fallbackTurn(input: SetupTurnInput): SetupTurnResult {
  const actions: SetupProposedAction[] = [];
  const msg = input.message.toLowerCase();
  // "what's filled / what's left / progress" → report state (no document attached to act on).
  if (!input.attachment && PROGRESS_RE.test(input.message)) {
    const isiActions = input.hasIsi ? [] : [{ type: "flag_isi" as const, summary: "An approved ISI is required before launch — add or confirm one" }];
    return { reply: describeProgress(input.known, input.hasIsi), actions: sanitizeActions(isiActions, input) };
  }
  if (input.attachment) {
    actions.push({ type: "ingest_document", summary: `Ingest “${input.attachment.name}” for MLR review` });
  }
  actions.push(...heuristicFieldActions(input.message, input.known));
  // "never/don't/block/always" → a conversation rule.
  if (/\b(never|don'?t|do not|avoid|block|always|must|require)\b/.test(msg)) {
    actions.push({ type: "draft_rule", ruleFeedback: input.message.trim(), ruleScope: "persona", summary: `Draft rule: ${input.message.trim().slice(0, 80)}` });
  }
  if (!input.hasIsi) {
    actions.push({ type: "flag_isi", summary: "An approved ISI is required before launch — add or confirm one" });
  }
  if (!input.attachment && !actions.length && !/\w/.test(msg)) {
    actions.push({ type: "request_upload", summary: "Upload a deck / PI / ISI / FAQ so I can build from it" });
  }
  const reply = input.attachment
    ? `Got your document — I can pull “${input.attachment.name}” into the approved library for MLR review, then draft the setup sections from it. Want me to?`
    : actions.some((a) => a.type === "set_field")
      ? "Sure — I've lined up that change for you to confirm on the right."
      : actions.some((a) => a.type === "draft_rule")
        ? "Makes sense — I can turn that into a conversation rule for the rep. Confirm and I'll add it for review."
        : "Tell me about the product, or share a deck / PI / FAQ and I'll draft the setup from it.";
  return { reply, actions: sanitizeActions(actions, input) };
}

/**
 * Run one agentic setup turn. Returns a humanlike reply plus proposed (unexecuted) actions the
 * caller surfaces for confirmation. Falls back to a deterministic turn when no LLM is available or
 * the model output can't be parsed — the assistant is never a dead form.
 */
export async function setupAssistantTurn(
  input: SetupTurnInput,
  llm?: (system: string, user: string) => Promise<string | null>,
): Promise<SetupTurnResult> {
  if (!llm) return fallbackTurn(input);

  const knownLines = SETTABLE_FIELDS
    .filter((f) => isSet(input.known, f.key))
    .map((f) => `- ${f.label} (${f.key}): ${str(input.known?.[f.key])}`);
  const context = [
    input.hasIsi ? "An approved ISI already exists." : "No approved ISI yet (required before launch).",
    knownLines.length ? `Already set (do NOT propose overwriting these):\n${knownLines.join("\n")}` : "Nothing set yet.",
    input.attachment
      ? `A document is attached this turn: "${input.attachment.name}". Excerpt:\n"""${input.attachment.text.slice(0, MAX_DOC_CHARS)}"""`
      : "No document attached this turn.",
  ].join("\n\n");
  const convo = (input.history ?? [])
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  const user = `${context}\n\n${convo ? `Conversation so far:\n${convo}\n\n` : ""}User: ${input.message.trim()}`;

  const raw = await llm(SYSTEM, user).catch(() => null);
  const parsed = raw ? parseFirstJsonObject(raw) : null;
  if (!parsed) return fallbackTurn(input);

  const reply = str(parsed.reply);
  const actions = sanitizeActions(parsed.actions, input);
  // A blank reply with no actions is a non-answer — fall back so the user is never left hanging.
  if (!reply && !actions.length) return fallbackTurn(input);
  return { reply: reply || fallbackTurn(input).reply, actions };
}
