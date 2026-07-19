/**
 * Conversation orchestrator — the controlled agent graph for one HCP turn
 * (brief §18; PDF §7). It does NOT free-form generate. It classifies, routes,
 * retrieves approved content, builds from approved blocks, validates, runs the
 * final compliance gate, audits every step, and creates follow-ups.
 *
 *   classify → route → (retrieve+validate | refusal | AE | MSL | handoff | fallback)
 *           → build → validate → compliance gate → output + audit + follow-up
 *
 * Fail safe: if the gate blocks, the HCP gets a safe fallback, not the draft.
 */

import { asId, type ApprovedAnswerId, type HcpId, type SessionId } from "@lib/ids";
import { captureError } from "@lib/error-capture";
import { classify, complianceGate, route, validateGrounding, type PolicyRoute, type RiskClassification, isiAlreadyDelivered, stripEmbeddedIsi } from "@modules/compliance";
import type { RetrievalService } from "@modules/retrieval";
import { buildApprovedResponse, slideReference, type ApprovedAnswer, type ContentService, type GroundedComposer, type SafetyStatement } from "@modules/content";
import type { AuditService } from "@modules/audit";
import { type FollowUpService, type FollowUpType } from "@modules/followups";
import type { RuleSteering } from "@modules/rules";

export interface TurnContext {
  sessionId: SessionId;
  hcpId: HcpId;
  text: string;
  audience?: string;
  indication?: string;
  market?: string;
  /** Investigational product: clinical specifics (dose/safety/efficacy) are
   *  never answered directly — they route to Medical Information (MSL). Only
   *  publicly-disclosable product facts are spoken. */
  investigational?: boolean;
}

/** Intents that are clinical specifics — off-limits for an investigational product, so they route
 *  to Medical Information rather than being answered directly. NOTE: "trial_data" is deliberately
 *  NOT here. Trial/program/"what is X studying" questions are PUBLIC program facts we hold approved
 *  content for; hard-bouncing the whole trial_data intent made a single word flip the route (e.g.
 *  "what is the clinical PROGRAM studying" → answered, but "…clinical VIEW studying" → bounced).
 *  Instead we ATTEMPT an approved answer and let retrieval + the grounding gate decide: a public
 *  program fact is answered; a deep efficacy/endpoint ask finds no approved content and falls back
 *  safely. Dosing/safety/administration stay bounced — those are genuine clinical specifics. */
const CLINICAL_SPECIFICS = new Set(["dosing", "safety", "administration"]);

export interface TurnOutput {
  route: PolicyRoute;
  responseText: string;
  sourceIds: string[];
  isiAttached: boolean;
  decision: "approved" | "blocked";
  reasons: string[];
  followUpType?: FollowUpType;
  /** Detail-aid slide to display (source-driven "tool call"), if any. */
  detailAidSlideId?: string;
}

type FollowUpSuggestion = { sourceId?: string; slideId?: string };
type AuditEvent = Awaited<ReturnType<AuditService["forSession"]>>[number];
type RetrievalSettled =
  | { result: Awaited<ReturnType<RetrievalService["retrieveApproved"]>>; retrievalText: string; latencyMs: number }
  | { error: unknown; latencyMs: number };
type RankedAnswers = {
  answers: ApprovedAnswer[];
  led: ApprovedAnswer[];
  promoted?: { answer: ApprovedAnswer; trial: string };
};
type SpeculativeComposeResult =
  | { ok: true; text: string; latencyMs: number; wallMs: number; answerIds: string[]; topId: string }
  | { ok: false; reason: string };

const SAFE_FALLBACK =
  "I want to make sure I only share approved information. Let me connect you with someone who can help.";
const COMPOSER_TIMEOUT_MS = 2500;
const COMPOSER_REPAIR_GUIDANCE =
  "Recovery pass: write one compact spoken answer under 28 words using only the approved blocks. Answer the exact question, keep the slide cue if a slide is shown, and do not add background.";

// A short message that references the slides/deck or asks to continue but names NO topic of its
// own — its meaning depends on what was just discussed ("show me the slides", "tell me more",
// "walk me through it", "keep going"). Retrieval biases these toward the prior turn's topic.
const FOLLOWUP_RE = /\b(show me|show us|show it|pull up|walk me through|the slides?|the deck|the presentation|the detail aid|tell me more|more on (that|this|it)|what about (that|this|it)|continue|keep going|go on|next|yes|yeah|yep|sure(?: did| thing)?|okay|ok|please(?: do)?|go ahead|go for it|sounds good|absolutely|definitely|do that|that works|let'?s do it)\b/i;
const PURE_ACCEPTANCE_RE = /^(?:(?:yes|yeah|yep|sure(?:\s+(?:did|thing))?|okay|ok|please(?:\s+do)?|go\s+ahead|go\s+for\s+it|sounds\s+good|absolutely|definitely|do\s+that|that\s+works|show\s+(?:me|it)|let'?s\s+do\s+it)[\s.,!?]*)+$/i;

function isPureAcceptance(text: string): boolean {
  return PURE_ACCEPTANCE_RE.test(text.trim());
}

const PRODUCT_DOMAIN_SIGNAL_RE = /\b(?:mechanism|moa|factor\s*(?:xia|xi|11a)|fxia|program|trial|trials|study|studying|phase|indication|indications|fast\s+track|approved|approval|development|status|anticoagulant|inhibitor|safety|isi|warning|risk|slide|slides|deck|presentation|detail\s+aid)\b/i;
const LOW_SIGNAL_QUESTION_RE = /\b(?:what(?:'s|\s+is)|how\s+(?:does|do|is)|tell\s+me|explain|got\s+a\s+look)\b/i;
const SIGNAL_STOP = new Set([
  "the", "is", "a", "an", "of", "to", "in", "and", "or", "at", "as", "with", "for", "on", "by",
  "be", "are", "was", "it", "this", "that", "from", "per", "what", "which", "how", "do", "does",
  "can", "i", "you", "your", "me", "my", "about", "tell", "show", "approved", "information",
  "got", "look", "sure", "yeah", "yes", "ok", "okay", "please", "syndrome",
]);

function signalTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !SIGNAL_STOP.has(t));
}

function hasMeaningfulOverlap(question: string, answers: ApprovedAnswer[]): boolean {
  const q = signalTokens(question);
  if (!q.length || !answers.length) return false;
  const answerWords = new Set(signalTokens(answers.map((a) => `${a.topic} ${a.text}`).join(" ")));
  return q.some((word) => answerWords.has(word));
}

function shouldSafeFallbackLowSignal(rawText: string, retrievalText: string, answers: ApprovedAnswer[]): boolean {
  const raw = rawText.trim();
  if (!raw) return true;
  // A contextual follow-up intentionally retrieves using prior topic + the short acceptance text.
  if (retrievalText.trim() !== raw) return false;
  if (PRODUCT_DOMAIN_SIGNAL_RE.test(raw)) return false;
  if (hasMeaningfulOverlap(raw, answers)) return false;
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  return wordCount <= 5 || LOW_SIGNAL_QUESTION_RE.test(raw);
}

function asksMultipleDistinctQuestions(text: string): boolean {
  const qMarks = (text.match(/\?/g) ?? []).length;
  if (qMarks >= 2) return true;
  return /\b(?:and|also|plus)\b.+\b(?:what|how|why|when|where|which|tell|explain|show|program|mechanism|safety|trial|dose|dosing)\b/i.test(text);
}

const SPECULATIVE_PUBLIC_INFO_RE =
  /\b(?:big picture|overview|asset|what (?:is|are)|how does|how do|why focus|mechanism|moa|factor\s*(?:xia|xi|11a)|fxia|clotting|coagulation|cascade|pathway|program|librexia|milvexian|trial|trials|study|studying|phase|indication|indications|development|status|fast\s+track)\b/i;
const SPECULATIVE_RISK_STOP_RE =
  /\b(?:my patient|patient|patients?|should i|can i (?:use|prescribe|give|start)|recommend|dose|dosage|mg|administration|administer|bleeding|bleed|rash|adverse|side effects?|safety|warning|contraindication|pregnan|pediatric|children|renal|hepatic|surgery|off[-\s]?label|compare|versus|vs\.?|better|safer|superior|inferior|eliquis|apixaban|xarelto|rivaroxaban|warfarin|dabigatran|edoxaban)\b/i;

/**
 * Safe latency optimization: only public product/program/mechanism questions may start an early
 * grounded draft before the LLM classifier returns. It is never released until classification,
 * grounding, and the final compliance gate pass. Anything patient-specific, comparative, dosing,
 * safety/AE, or off-label stays sequential so raw risky text is not sent to the answer composer.
 */
function canSpeculativelyCompose(text: string, blockedTopics: string[]): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (blockedTopics.some((topic) => matchesTopic(clean, topic))) return false;
  if (SPECULATIVE_RISK_STOP_RE.test(clean)) return false;
  return SPECULATIVE_PUBLIC_INFO_RE.test(clean);
}

function canFastClassifyContextFollowup(text: string, blockedTopics: string[]): boolean {
  const clean = text.trim();
  if (!clean || clean.split(/\s+/).filter(Boolean).length > 9) return false;
  if (!FOLLOWUP_RE.test(clean)) return false;
  if (blockedTopics.some((topic) => matchesTopic(clean, topic))) return false;
  return !SPECULATIVE_RISK_STOP_RE.test(clean);
}

function canFastClassifyLivePublicInfo(text: string, blockedTopics: string[]): boolean {
  if (blockedTopics.some((topic) => matchesTopic(text, topic))) return false;
  return canSpeculativelyCompose(text, blockedTopics);
}

function rankAnswersForTurn(answers: ApprovedAnswer[], specificityText: string, leadTopics: string[]): RankedAnswers {
  let ranked = [...answers];
  let led: ApprovedAnswer[] = [];
  if (leadTopics.length && ranked.length > 1) {
    led = ranked.filter((a) => leadTopics.some((t) => matchesTopic(`${a.topic} ${a.text}`, t)));
    if (led.length) {
      const rest = ranked.filter((a) => !led.includes(a));
      ranked = [...led, ...rest];
    }
  }
  const namedTrials = namedTrialTopics(specificityText);
  let promoted: RankedAnswers["promoted"];
  if (namedTrials.length === 1 && ranked.length > 1) {
    const idx = ranked.findIndex((a) => namedTrials[0]!.topic.test(a.topic));
    if (idx > 0) {
      const copy = [...ranked];
      const [specific] = copy.splice(idx, 1);
      ranked = [specific!, ...copy];
      promoted = { answer: specific!, trial: namedTrials[0]!.name };
    }
  }
  return { answers: ranked, led, promoted };
}

function addNamedTrialAnswerIfMissing(answers: ApprovedAnswer[], specificityText: string, allAnswers: ApprovedAnswer[]): { answers: ApprovedAnswer[]; added?: ApprovedAnswer; trial?: string } {
  const namedTrials = namedTrialTopics(specificityText);
  if (namedTrials.length !== 1) return { answers };
  const trial = namedTrials[0]!;
  if (answers.some((a) => trial.topic.test(a.topic))) return { answers };
  const added = allAnswers.find((a) => a.mlr.status === "active" && trial.topic.test(a.topic));
  if (!added) return { answers };
  return { answers: [added, ...answers.filter((a) => a.id !== added.id)], added, trial: trial.name };
}

function slideGuidance(slideTitle?: string, relatedTitle?: string): string[] {
  return slideTitle
    ? [`A detail-aid slide titled "${slideTitle}" is being shown on the doctor's screen${relatedTitle ? ` (a "${relatedTitle}" slide is also available)` : ""}. Weave in a mention of the slide the way a real rep would: give a sentence or two of the actual answer FIRST, THEN point at the slide in one short, natural clause (e.g. "— I've pulled up the ${slideTitle} slide so you can follow along —") and keep going. Do NOT open with it (leading with it reads robotic), and do NOT leave it to the very last line. Vary the wording, keep it a short clause, and don't omit it unless you were explicitly asked to be terse.`]
    : [];
}

function disclosureAlreadyGiven(priorEvents: AuditEvent[]): boolean {
  return priorEvents.some((e) => e.type === "response_output" && typeof e.payload.text === "string" && (e.payload.text as string).trim().length > 0);
}

function antiRepeatGuidance(priorEvents: AuditEvent[]): string[] {
  const priorReplies = priorEvents
    .filter((e) => e.type === "response_output" && typeof e.payload.text === "string")
    .map((e) => (e.payload.text as string).split(/\n\nImportant Safety Information:/)[0]!.trim())
    .filter((t) => t.length > 20);
  const covered = [...new Set(priorReplies)].slice(-8);
  return covered.length
    ? [
        `Earlier in THIS conversation you already said:\n${covered
          .map((t, i) => `(${i + 1}) ${t.slice(0, 180)}`)
          .join("\n")}\nDon't sound repetitive: do NOT repeat an earlier answer word-for-word or open with the same phrase, and don't pad a reply with background that isn't what was asked. Restating an important or directly-relevant point is fine, but say it in DIFFERENT words and framing and lead with something new. When the approved content genuinely has nothing new to add, say so briefly and offer to go deeper rather than repeating an earlier answer verbatim.`,
      ]
    : [];
}

// The three LIBREXIA trials, each as (how the doctor NAMES it) → (the topic of that trial's answer).
// When a query names exactly ONE of these, we lead with that trial's approved answer so the RIGHT
// slide shows ("ask about stroke → show the stroke slide") and its topic anchors the next follow-up.
// This is exact trial disambiguation over three known trials — not general keyword search.
const TRIAL_TOPICS: { name: string; query: RegExp; topic: RegExp }[] = [
  { name: "stroke", query: /\bstrokes?\b|\bTIA\b|transient ischemic/i, topic: /stroke/i },
  { name: "af", query: /\batrial\b|\bAF\b|fibrillation|flutter/i, topic: /atrial|\bAF\b/i },
  { name: "acs", query: /\bACS\b|acute coronary|coronary syndrome/i, topic: /acute coronary|\bACS\b/i },
];

function namedTrialTopics(text: string): typeof TRIAL_TOPICS {
  const clean = text.toLowerCase().replace(/[‐‑‒–—-]/g, " ");
  const words = new Set(clean.match(/[a-z0-9]+/g) ?? []);
  return TRIAL_TOPICS.filter((trial) => {
    if (trial.name === "stroke") return /\blibrexia\s+stroke\b/.test(clean) || words.has("stroke") || words.has("strokes") || words.has("tia") || /transient\s+ischemic/.test(clean);
    if (trial.name === "af") return /\blibrexia\s+af\b/.test(clean) || words.has("af") || words.has("atrial") || words.has("fibrillation") || words.has("flutter");
    if (trial.name === "acs") return /\blibrexia\s+acs\b/.test(clean) || words.has("acs") || /acute\s+coronary|coronary\s+syndrome/.test(clean);
    return trial.query.test(text);
  });
}

/**
 * When the exact ISI block is appended, do not also repeat standalone safety/disclosure
 * sentences in the conversational body. The body still stays grounded in approved content; this
 * only removes duplicates already covered verbatim by the approved ISI.
 */
function stripDisclosureLead(sentence: string): string {
  return sentence
    .replace(/^\s*(?:just to note,?\s*)?(?:as\s+)?i(?:'m| am)\s+an?\s+ai(?:\s+pharmaceutical)?\s+representative(?:\s+for\s+[^,.]+)?[,.]?\s*(?:and\s+)?/i, "")
    .replace(/^\s*as\s+an?\s+ai(?:\s+pharmaceutical)?\s+representative[,.]?\s*/i, "")
    .replace(/^\s*i\s+(?:want to|should)\s+(?:note|mention)(?:\s+upfront)?\s+that\s+/i, "")
    .replace(/^\s*to\s+note\s+upfront\s+that\s+/i, "");
}

function isStatusQuestion(question: string): boolean {
  return /\b(fda|approved|approval|regulatory|status|investigational|development|fast\s+track)\b/i.test(question);
}

/**
 * Did the composed answer actually CUE the detail-aid slide — name it or point at the screen? Only
 * then do we switch the deck. A silent switch draws no attention (you don't look at a slide nobody
 * mentioned), so if the rep didn't reference it we stay put. Mentioning the slide IS the rep's
 * "switch slides" tool call; the client (slideCueDelay) then times the switch to WHEN the cue is
 * spoken. Both the deterministic builder (slideReference) and the LLM composer (told to name the
 * slide when one is shown) include this cue, so a real slide answer passes; a cue-less reply doesn't.
 */
export function cuesASlide(text: string): boolean {
  return /\bslides?\b|\bon (your|the) screen\b|take a look|you can (see|look)|pulled up|i'?m showing|shown on\b|laid out on\b|let'?s (move|go|turn) to\b|we'?ll start with\b/i.test(text);
}

/** Periods inside abbreviations ("U.S.", "e.g.", "Dr.") are NOT sentence boundaries. The
 *  sentence splitter below requires whitespace/end after the terminal punctuation, so a mid-word
 *  dot like the one in "U.S. FDA" would otherwise be skipped as unmatched text — dropping the "U."
 *  and mangling the phrase to "S. FDA". Mask those dots to a sentinel before splitting, restore
 *  after. (Regression: "U.S. FDA Fast Track" rendered as "S. FDA Fast Track".) */
const ABBREV_DOT = String.fromCharCode(1); // sentinel that never occurs in approved copy; restored after splitting
function maskAbbreviationDots(s: string): string {
  return s
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ABBREV_DOT)) // U.S., U.S.A., e.g.
    .replace(/\b(?:Dr|Mr|Mrs|Ms|St|No|vs|etc|Fig|Inc|Ltd|Co|approx|Prof)\./gi, (m) => m.replace(/\./g, ABBREV_DOT));
}
function unmaskAbbreviationDots(s: string): string {
  return s.split(ABBREV_DOT).join(".");
}

function sanitizeApprovedBody(body: string, opts: { isiText?: string; disclosureGiven: boolean; question: string }): string {
  const isi = (opts.isiText ?? "").toLowerCase();
  if (!body.trim()) return body;
  const sentences = maskAbbreviationDots(body).match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [body];
  const kept: string[] = [];
  for (const sentence of sentences) {
    const cleaned = stripDisclosureLead(stripSpeechMarkdown(sentence));
    const s = cleaned.toLowerCase();
    if (!cleaned.trim()) continue;
    const repeatsNotApproved =
      /\b(?:not\s+(?:yet\s+)?approved|not\s+(?:yet\s+)?fda[-\s]?approved)\b/.test(s) &&
      /\b(?:fda|regulatory authorit)/.test(s) &&
      (/\bnot approved\b/.test(isi) || (opts.disclosureGiven && !isStatusQuestion(opts.question)));
    if (repeatsNotApproved) continue;
    if (isi && /\bsafety and efficacy\b/.test(s) && /\bsafety and efficacy\b/.test(isi)) continue;
    if (isi && /\bclinical questions?\b/.test(s) && /\bmedical information\b/.test(s) && /\bmedical information\b/.test(isi)) continue;
    kept.push(cleaned);
  }
  const trimmed = unmaskAbbreviationDots(kept.join("").replace(/\s+/g, " ").trim());
  return trimmed || stripSpeechMarkdown(body);
}

export function stripSpeechMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    // Dashes used as a pause read badly aloud (the TTS makes a hard stop on "Sure — let me…").
    // Turn em/en dashes, " -- ", and spaced hyphens into a comma pause. In-word hyphens
    // ("Fast-Track", "on-label", "decile 2-4") have no surrounding spaces, so they're left intact.
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+--+\s+/g, ", ")
    .replace(/\s+-\s+/g, ", ")
    .replace(/\s+([,.;:!?])/g, "$1"); // tidy any stray space before punctuation
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Does the HCP's text touch a coaching-rule topic? Matches on any significant word of the
 * topic (length ≥ 4, whole-word) so a single-word topic matches exactly and a
 * noisy multi-word topic still matches on its key terms. Blocked-topic use is fail-safe, so
 * a slightly loose match only ever over-routes to Medical Info — never speaks something new.
 */
function matchesTopic(text: string, topic: string): boolean {
  const hay = ` ${text.toLowerCase()} `;
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (!words.length) return false;
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay));
}

export class TurnOrchestrator {
  /** The classifier used per turn. Defaults to the deterministic keyword
   *  classifier; the container injects the env-selected LLM provider (Claude/
   *  OpenAI/Thinking-Machines) which itself fails safe to keyword on error. */
  private readonly classifier: (text: string) => Promise<RiskClassification>;

  /** Optional LLM that composes the answer from approved blocks. null = deterministic builder. */
  private readonly composer: GroundedComposer | null;

  constructor(
    private readonly content: ContentService,
    private readonly retrieval: RetrievalService,
    private readonly audit: AuditService,
    private readonly followups: FollowUpService,
    classifier?: (text: string) => Promise<RiskClassification>,
    composer?: GroundedComposer | null,
  ) {
    this.classifier = classifier ?? (async (t) => classify(t));
    this.composer = composer ?? null;
  }

  async handleTurn(
    ctx: TurnContext,
    opts?: {
      classify?: (text: string) => Promise<RiskClassification>;
      /** Composer for this turn (overrides the default). null = force the deterministic builder. */
      composer?: GroundedComposer | null;
      /** Rehearsal coaching (style/emphasis) folded into the composer prompt for this turn. */
      coaching?: string[];
      /** Runtime steering from the rep's ACTIVE coaching rules (see activeSteering). */
      steering?: RuleSteering;
      /** Rehearsal/coaching preview: still classifies, retrieves, composes, grounds and gates
       *  exactly like a live turn, but creates NO follow-up (rehearsal must not enqueue CRM work). */
      preview?: boolean;
      /** Realtime voice can set tight budgets: if the LLM misses them, fail safe to deterministic. */
      classificationTimeoutMs?: number;
      composerTimeoutMs?: number;
      composerMaxTokens?: number;
      /** Start a low-risk grounded compose while classification finishes; final gate still decides. */
      speculativeCompose?: boolean;
      /** Live mic/video path: no extra LLM repair wait after a slow or invalid draft. */
      liveVoice?: boolean;
      /** Avoid optional second-slide offers for live voice; they lengthen speech and create queues. */
      suppressRelatedSlide?: boolean;
    },
  ): Promise<TurnOutput> {
    const turnStarted = Date.now();
    const retrievalStarted = Date.now();
    // Context-aware retrieval: a bare follow-up ("show me the slides", "tell me more") carries no
    // topic — bias it toward what we were just discussing so it surfaces the RELEVANT slide, not a
    // generic one. Only short follow-ups pay the extra lookup; every other query still retrieves in
    // parallel with classification exactly as before.
    const retrievalTextPromise =
      FOLLOWUP_RE.test(ctx.text) && ctx.text.split(/\s+/).filter(Boolean).length <= 9
        ? this.contextualRetrievalText(ctx)
        : Promise.resolve(ctx.text);
    const retrievalPromise: Promise<RetrievalSettled> = retrievalTextPromise
      .then((text) =>
        this.retrieval
          .retrieveApproved({
            text,
            context: { audience: ctx.audience, indication: ctx.indication, market: ctx.market },
          })
          .then(
            // Keep the text actually used for retrieval — for a bare follow-up it's the
            // context-biased text (prior topic prepended), which the trial-specificity re-rank below
            // needs so "Yeah, sure." after a stroke answer stays on stroke.
            (result) => ({ result, retrievalText: text, latencyMs: Date.now() - retrievalStarted }),
            (error: unknown) => ({ error, latencyMs: Date.now() - retrievalStarted }),
          ),
      );
    const overrideComposer = opts?.composer;
    const activeComposer = overrideComposer !== undefined ? overrideComposer : this.composer;
    const composerTimeoutMs = opts?.composerTimeoutMs ?? COMPOSER_TIMEOUT_MS;
    const blockedTopicsForTurn = opts?.steering?.blockedTopics ?? [];
    const fastContextFollowup = canFastClassifyContextFollowup(ctx.text, blockedTopicsForTurn);
    const fastLivePublicInfo = Boolean(opts?.speculativeCompose && !opts?.classify && canFastClassifyLivePublicInfo(ctx.text, blockedTopicsForTurn));
    const speculativeComposePromise =
      opts?.speculativeCompose && activeComposer?.available() && canSpeculativelyCompose(ctx.text, blockedTopicsForTurn)
        ? this.speculativeCompose(ctx, retrievalPromise, activeComposer, opts, composerTimeoutMs)
        : undefined;
    const classificationStarted = Date.now();
    let classifierFallback: string | undefined;
    let classification: RiskClassification;
    try {
      if (fastContextFollowup && !opts?.classify) {
        classification = classify(ctx.text);
      } else if (fastLivePublicInfo) {
        classification = classify(ctx.text);
      } else {
        const classifyPromise = (opts?.classify ?? this.classifier)(ctx.text);
        classification = opts?.classificationTimeoutMs ? await withTimeout(classifyPromise, opts.classificationTimeoutMs, "classification_timeout") : await classifyPromise;
      }
    } catch (error) {
      classifierFallback = error instanceof Error ? error.message : "classifier_error";
      // Audited below, but ALSO surface it: a classifier-vendor outage silently degrading every turn
      // to keyword classification was previously invisible outside the per-session audit UI.
      captureError(error, { phase: "orchestrator.classify", sessionId: ctx.sessionId });
      classification = classify(ctx.text);
    }
    await this.audit.record(ctx.sessionId, "classification", {
      ...classification,
      latencyMs: Date.now() - classificationStarted,
      turnElapsedMs: Date.now() - turnStarted,
      ...(fastContextFollowup && !opts?.classify ? { fastPath: "context_followup" } : {}),
      ...(fastLivePublicInfo ? { fastPath: "live_public_info" } : {}),
      ...(classifierFallback ? { fallback: classifierFallback } : {}),
    });

    let r = route(classification);
    // Investigational guardrail: never answer clinical specifics directly for an
    // unapproved compound — send them to Medical Information for a compliant reply.
    if (ctx.investigational && r === "approved_answer" && CLINICAL_SPECIFICS.has(classification.intent)) {
      r = "medical_information";
    }
    // Coaching steering (active, compliance-cleared blocked_topic rules): if the brand
    // has trained the rep to NOT discuss a topic, route it to Medical Information rather
    // than answering. Purely RESTRICTIVE — it can only narrow what the rep says, never
    // widen it — so it cannot weaken the compliance gate.
    const blockedTopics = blockedTopicsForTurn;
    if (r === "approved_answer" && blockedTopics.some((t) => matchesTopic(ctx.text, t))) {
      const hit = blockedTopics.find((t) => matchesTopic(ctx.text, t));
      await this.audit.record(ctx.sessionId, "coaching_rule_applied", { rule: "blocked_topic", topic: hit });
      r = "medical_information";
    }

    // Build a candidate response per route. Approved answers are the only path
    // that composes from retrieved content; everything else is a controlled,
    // pre-approved transition that creates a follow-up.
    let responseText = "";
    let sourceIds: string[] = [];
    let isiAttached = false;
    let requiredSafetyText: string | undefined;
    let detailAidSlideId: string | undefined;
    let followUpType: FollowUpType | undefined;
    let gateClassification = classification;
    let followUpSuggestion: FollowUpSuggestion | undefined;

    if (r === "approved_answer") {
      const retrievalSettled = await retrievalPromise;
      if ("error" in retrievalSettled) {
        captureError((retrievalSettled as { error?: unknown }).error ?? new Error("retrieval_error"), { phase: "orchestrator.retrieval", sessionId: ctx.sessionId });
        await this.audit.record(ctx.sessionId, "retrieval", {
          action: "retrieval_error",
          latencyMs: retrievalSettled.latencyMs,
        });
        return this.finalize(ctx, "fallback", classification, SAFE_FALLBACK, [], false, undefined, undefined, undefined, opts?.preview ?? false);
      }
      const result = retrievalSettled.result;
      await this.audit.record(ctx.sessionId, "retrieval", {
        accepted: result.answers.map((a) => a.id),
        rejected: result.rejected,
        latencyMs: retrievalSettled.latencyMs,
        turnElapsedMs: Date.now() - turnStarted,
      });
      // Coaching steering (active ordering / hcp_pointer rules): if the rep was trained
      // to lead with a topic, and an approved answer for it is among the candidates, move
      // it to the front. Additive only — it re-ranks approved content, never adds any.
      // Trial specificity: when the doctor names ONE specific trial (stroke / AF / ACS), lead with
      // THAT trial's answer instead of the general LIBREXIA-program answer — so the named-trial
      // question shows the named-trial slide, and that topic anchors the next bare follow-up. If
      // semantic retrieval missed the exact named trial but the active KB has it, add that approved
      // block before ranking; this is a controlled exact-trial recovery, not free-form generation.
      // The named-trial signal comes from the query AND the coaching — so "actually use the LIBREXIA
      // stroke slide" (a coaching note) promotes the stroke answer + slide, not just the raw question.
      const specificityText = [
        ctx.text,
        ...(opts?.coaching ?? []),
      ].join(" ");
      const exactTrial = addNamedTrialAnswerIfMissing(result.answers, specificityText, await this.content.listAnswers());
      result.answers = exactTrial.answers;
      if (exactTrial.added) {
        await this.audit.record(ctx.sessionId, "retrieval", { action: "trial_specificity_added", answer: exactTrial.added.id, trial: exactTrial.trial });
      }
      const ranked = rankAnswersForTurn(result.answers, specificityText, opts?.steering?.leadTopics ?? []);
      result.answers = ranked.answers;
      if (ranked.led.length) {
        await this.audit.record(ctx.sessionId, "coaching_rule_applied", { rule: "conversation_ordering", led: ranked.led.map((a) => a.id) });
      }
      if (ranked.promoted) {
        await this.audit.record(ctx.sessionId, "retrieval", { action: "trial_specificity_promoted", answer: ranked.promoted.answer.id, trial: ranked.promoted.trial });
      }
      const top = result.answers[0];
      if (!top) {
        // No approved block → fail safe to fallback (content gap signal).
        return this.finalize(ctx, "fallback", classification, SAFE_FALLBACK, [], false, undefined, undefined, undefined, opts?.preview ?? false);
      }
      // Live Tavus voice should not hand the LLM the whole adjacent retrieval bundle unless the
      // HCP really asked multiple things. Extra blocks make the answer longer, then Tavus queues
      // TTS for many seconds after our gated text is ready. Keep a small context window (top two)
      // so the answer can still feel natural and informed, without becoming a mini deck recap.
      const answerBlocks = opts?.suppressRelatedSlide && !asksMultipleDistinctQuestions(ctx.text)
        ? result.answers.slice(0, 2)
        : result.answers;
      const actualRetrievalText = ("retrievalText" in retrievalSettled && retrievalSettled.retrievalText) || ctx.text;
      if (shouldSafeFallbackLowSignal(ctx.text, actualRetrievalText, result.answers)) {
        await this.audit.record(ctx.sessionId, "response_validation", {
          action: "low_signal_query_safe_fallback",
          text: ctx.text,
          topAnswer: String(top.id),
        });
        return this.finalize(ctx, "fallback", classification, SAFE_FALLBACK, [], false, undefined, undefined, undefined, opts?.preview ?? false);
      }
      // Resolve the on-screen slide titles so the rep can reference the detail aid the way a
      // person does ("you can see this on the … slide") and gesture at a SECOND relevant slide —
      // so the whole deck gets used across a conversation, not just the first page.
      const topSlide = top.detailAidSlideId ? await this.content.getSlide(top.detailAidSlideId) : null;
      // Offer a second slide for broad overview/program answers, but keep trial-specific answers
      // focused. Otherwise a stroke/AF/ACS answer can immediately offer the generic program slide,
      // and a bare "yeah sure" drags the doctor away from the specific trial they just asked about.
      const canOfferRelated = !opts?.suppressRelatedSlide && (!/\btrial\b/i.test(top.topic) || /\bprogram\b/i.test(top.topic));
      const relatedAns = canOfferRelated
        ? result.answers.find((a, i) => i > 0 && a.detailAidSlideId && a.detailAidSlideId !== top.detailAidSlideId)
        : undefined;
      const relatedSlide = relatedAns?.detailAidSlideId ? await this.content.getSlide(relatedAns.detailAidSlideId) : null;
      const slideTitle = topSlide?.title ?? topSlide?.label;
      const relatedTitle = relatedSlide?.title ?? relatedSlide?.label;
      // Required safety info (ISI) for this turn, if the classifier flagged it. Studio may
      // draft revised ISI wording through MLR, but runtime still appends the current active
      // approved block exactly and the gate validates that text before anything is spoken.
      const isiStatement = await this.firstSafetyStatement();
      const activeIsi = classification.isiRequired ? isiStatement : undefined;
      const priorEvents = await this.audit.forSession(ctx.sessionId);
      const isiDelivered = Boolean(activeIsi && isiAlreadyDelivered(priorEvents, activeIsi.text));
      const isi = activeIsi && !isiDelivered ? activeIsi : undefined;
      // The AI/investigational disclosure is a per-SESSION obligation (the greeting carries
      // it; the first answer may repeat it). Re-stating it on every reply reads as canned —
      // once any answer has gone out, disclosure guidance is dropped and the composer is
      // told not to restate it.
      const disclosureGiven = disclosureAlreadyGiven(priorEvents);
      // The on-screen slide is offered to the composer as a HINT so it can weave a BRIEF, varied
      // reference itself (and drop it when asked to be terse) — instead of a fixed bolt-on sentence
      // that read repetitively. Rehearsal + active persona_style coaching also flow in as guidance.
      // None of this can override grounding or the gate.
      const slideHint = slideGuidance(slideTitle, relatedTitle);
      const steeringGuidance = (opts?.steering?.styleGuidance ?? []).filter(
        (g) => !disclosureGiven || !/disclos|investigational|not fda/i.test(g),
      );
      // Conversation-aware de-dup across the WHOLE session (not just the last turn): show the
      // composer EVERYTHING it has already told this doctor so it answers with genuinely new
      // information or a fresh angle instead of re-stating the same few blocks. Deduped + capped so
      // the prompt stays lean. Advisory only (never overrides grounding/gate); deterministic ignores it.
      const antiRepeat = antiRepeatGuidance(priorEvents);
      const guidance = [...(opts?.coaching ?? []), ...steeringGuidance, ...slideHint, ...antiRepeat];
      const composeFn = activeComposer?.available()
        ? (q: string, b: ApprovedAnswer[], extraGuidance: string[] = [], maxTokens = opts?.composerMaxTokens) => activeComposer.compose({
            question: q,
            blocks: b,
            guidance: extraGuidance.length ? [...guidance, ...extraGuidance] : guidance,
            safety: isi?.text,
            alreadyDisclosed: disclosureGiven,
            maxTokens,
            sessionId: ctx.sessionId,
          })
        : undefined;
      // Deterministic fallback (no LLM) speaks approved text + one brief slide cue; it cannot weave,
      // so the ISI is appended verbatim below.
      const responseSeed = `${ctx.sessionId}:${ctx.text}:${priorEvents.length}:${top.id}`;
      const deterministic = () => buildApprovedResponse(answerBlocks, { includeIsi: false, slideTitle, seed: responseSeed })?.text ?? top.text;
      let body: string;
      if (composeFn) {
        try {
          // Deterministic backstop: whatever the model wove in, an embedded ISI copy is
          // removed — the platform alone decides when the exact ISI is appended.
          const composerStarted = Date.now();
          const speculative = speculativeComposePromise ? await speculativeComposePromise : undefined;
          let usedRepair = false;
          if (speculative?.ok === false && speculative.reason !== "composer_output_truncated") {
            throw new Error(`speculative_${speculative.reason}`);
          }
          const useSpeculative =
            speculative?.ok === true &&
            speculative.topId === String(top.id);
          let composeResult = useSpeculative
            ? { text: speculative.text, latencyMs: speculative.latencyMs, truncated: false }
            : speculative?.ok === false && speculative.reason === "composer_output_truncated"
              ? opts?.liveVoice
                ? (() => { throw new Error("composer_output_truncated"); })()
                : await withTimeout(composeFn(ctx.text, answerBlocks, [COMPOSER_REPAIR_GUIDANCE], Math.max(120, Math.min(opts?.composerMaxTokens ?? 180, 180))), Math.min(1800, composerTimeoutMs), "composer_repair_timeout")
              : await withTimeout(composeFn(ctx.text, answerBlocks), composerTimeoutMs, "composer_timeout");
          if (!useSpeculative && speculative?.ok === false && speculative.reason === "composer_output_truncated") usedRepair = !opts?.liveVoice;
          if (!useSpeculative && composeResult.truncated) {
            if (opts?.liveVoice) throw new Error("composer_output_truncated");
            composeResult = await withTimeout(composeFn(ctx.text, answerBlocks, [COMPOSER_REPAIR_GUIDANCE], Math.max(120, Math.min(opts?.composerMaxTokens ?? 180, 180))), Math.min(1800, composerTimeoutMs), "composer_repair_timeout");
            usedRepair = true;
            if (composeResult.truncated) throw new Error("composer_output_truncated");
          }
          const composerWallMs = useSpeculative ? speculative.wallMs : Date.now() - composerStarted;
          await this.audit.record(ctx.sessionId, "response_validation", {
            action: "composer_success",
            composer: activeComposer?.name,
            latencyMs: composeResult.latencyMs,
            wallMs: composerWallMs,
            speculative: useSpeculative,
            repair: usedRepair,
            timeoutMs: composerTimeoutMs,
            turnElapsedMs: Date.now() - turnStarted,
          });
          const composed = stripSpeechMarkdown(stripEmbeddedIsi(composeResult.text.trim(), isiStatement?.text ?? ""));
          if (!composed) {
            body = deterministic();
          } else {
            // Grounding is checked against approved answer blocks only. The exact ISI is appended
            // after composition, so a model-generated safety paraphrase is not needed and cannot
            // be used to satisfy the gate.
            const groundBlocks = answerBlocks.map((a) => a.text);
            const grounding = validateGrounding({ answer: composed, blocks: groundBlocks });
            if (grounding.grounded) {
              body = composed; // the composer may weave the slide reference; approved ISI is appended below.
            } else {
              const repair = opts?.liveVoice || usedRepair
                ? null
                : await withTimeout(composeFn(ctx.text, answerBlocks, [COMPOSER_REPAIR_GUIDANCE], Math.max(120, Math.min(opts?.composerMaxTokens ?? 180, 180))), Math.min(1800, composerTimeoutMs), "composer_repair_timeout")
                    .catch(() => null);
              const repaired = repair?.truncated ? "" : stripSpeechMarkdown(stripEmbeddedIsi((repair?.text ?? "").trim(), isiStatement?.text ?? ""));
              const repairGrounding = repaired ? validateGrounding({ answer: repaired, blocks: groundBlocks }) : null;
              if (repairGrounding?.grounded) {
                await this.audit.record(ctx.sessionId, "response_validation", {
                  action: "composer_repair_success",
                  composer: activeComposer?.name,
                  latencyMs: repair?.latencyMs,
                  reason: "initial_grounding_failed",
                  turnElapsedMs: Date.now() - turnStarted,
                });
                body = repaired;
              } else {
              await this.audit.record(ctx.sessionId, "response_validation", {
                grounded: false,
                coverage: grounding.coverage,
                ungroundedNumbers: grounding.ungroundedNumbers,
                novelTokens: grounding.novelTokens.slice(0, 12),
                repairTried: Boolean(repair),
                repairTruncated: Boolean(repair?.truncated),
                repairGrounded: Boolean(repairGrounding?.grounded),
                action: opts?.liveVoice ? "live_voice_fallback_to_approved_text" : "fallback_to_approved_text",
              });
              body = deterministic();
              }
            }
          }
        } catch (error) {
          captureError(error, { phase: "orchestrator.compose", sessionId: ctx.sessionId, timeoutMs: composerTimeoutMs });
          await this.audit.record(ctx.sessionId, "response_validation", {
            action: "composer_fallback",
            reason: error instanceof Error ? error.message : "error_or_timeout",
            timeoutMs: composerTimeoutMs,
            turnElapsedMs: Date.now() - turnStarted,
          });
          body = deterministic();
        }
      } else {
        await this.audit.record(ctx.sessionId, "response_validation", {
          action: "deterministic_composer",
          turnElapsedMs: Date.now() - turnStarted,
        });
        body = deterministic();
      }
      body = sanitizeApprovedBody(body, { isiText: isi?.text, disclosureGiven, question: ctx.text });
      // A detail-aid slide is on screen for this answer, but neither the composer nor the
      // deterministic builder referenced it — weave in a brief, varied cue so the rep ALWAYS points
      // the doctor at the slide when one exists (and the deck then reliably switches on that cue).
      // The gate below still holds for the no-slide case: no slide → no cue → no switch.
      if (slideTitle && !cuesASlide(body)) {
        body = `${body}${slideReference({ seed: responseSeed, slideTitle, relatedTitle })}`;
      }
      if (isi) {
        requiredSafetyText = isi.text;
        body = `${body}\n\nImportant Safety Information: ${isi.text}`;
        isiAttached = true;
      } else if (activeIsi && isiDelivered) {
        gateClassification = { ...classification, isiRequired: false };
        await this.audit.record(ctx.sessionId, "response_validation", {
          action: "isi_already_delivered",
          safetyStatementId: String(activeIsi.id),
        });
      }
      responseText = body;
      sourceIds = answerBlocks.map((a) => a.id);
      followUpSuggestion =
        relatedAns?.id ? { sourceId: String(relatedAns.id), slideId: relatedAns.detailAidSlideId ? String(relatedAns.detailAidSlideId) : undefined } : undefined;
      // Only switch the deck when the answer actually CUES the slide — otherwise a silent switch
      // draws no attention. The client times the switch to when the cue is spoken (slideCueDelay).
      detailAidSlideId = cuesASlide(body) ? top.detailAidSlideId : undefined;
      if (detailAidSlideId) await this.audit.record(ctx.sessionId, "response_output", { detailAid: detailAidSlideId });
    } else if (r === "off_label_refusal") {
      responseText =
        "That use falls outside the approved information I can discuss. I can arrange medical follow-up on this question.";
      followUpType = "msl";
    } else if (r === "adverse_event") {
      responseText =
        "Thank you for reporting that. I'm logging this so our safety team can follow up. Can you share any additional detail?";
      followUpType = "pharmacovigilance";
    } else if (r === "medical_information") {
      // A safety-information ask has an APPROVED verbatim answer — the ISI. Deliver it
      // (once per session) alongside the Medical Information handoff instead of only
      // bouncing; anything deeper still routes. Fail-safe: without an active ISI, or
      // once it's been delivered, the plain handoff stands.
      const miIsi = classification.isiRequired ? await this.firstSafetyStatement() : undefined;
      const miEvents = miIsi ? await this.audit.forSession(ctx.sessionId) : [];
      if (miIsi && !isiAlreadyDelivered(miEvents, miIsi.text)) {
        const retrievalSettled = await retrievalPromise;
        if (!("error" in retrievalSettled)) {
          const safetyAnswer = retrievalSettled.result.answers.find((a) => /safety|isi|important safety/i.test(a.topic));
          detailAidSlideId = safetyAnswer?.detailAidSlideId ?? detailAidSlideId;
        }
        responseText = `Here is the approved safety information I can share.

Important Safety Information: ${miIsi.text}

For anything beyond this, I can connect you with our medical information team.`;
        requiredSafetyText = miIsi.text;
        isiAttached = true;
      } else {
        responseText = "That's a detailed medical question. I can connect you with our medical information team.";
      }
      followUpType = "medical_information";
    } else if (r === "human_handoff") {
      responseText = "Of course, I can arrange for a representative to contact you.";
      followUpType = "human_rep";
    } else {
      responseText = SAFE_FALLBACK;
    }

    return this.finalize(ctx, r, gateClassification, responseText, sourceIds, isiAttached, requiredSafetyText, followUpType, detailAidSlideId, opts?.preview ?? false, followUpSuggestion);
  }

  private async speculativeCompose(
    ctx: TurnContext,
    retrievalPromise: Promise<RetrievalSettled>,
    activeComposer: GroundedComposer,
    opts: {
      coaching?: string[];
      steering?: RuleSteering;
      suppressRelatedSlide?: boolean;
      composerMaxTokens?: number;
    } | undefined,
    composerTimeoutMs: number,
  ): Promise<SpeculativeComposeResult> {
    try {
      const retrievalSettled = await retrievalPromise;
      if ("error" in retrievalSettled) return { ok: false, reason: "retrieval_error" };
      const specificityText = [ctx.text, ...(opts?.coaching ?? [])].join(" ");
      const exactTrial = addNamedTrialAnswerIfMissing(retrievalSettled.result.answers, specificityText, await this.content.listAnswers());
      const ranked = rankAnswersForTurn(exactTrial.answers, specificityText, opts?.steering?.leadTopics ?? []);
      const top = ranked.answers[0];
      if (!top) return { ok: false, reason: "no_approved_answer" };
      const answerBlocks = opts?.suppressRelatedSlide && !asksMultipleDistinctQuestions(ctx.text)
        ? ranked.answers.slice(0, 2)
        : ranked.answers;
      if (shouldSafeFallbackLowSignal(ctx.text, retrievalSettled.retrievalText, ranked.answers)) {
        return { ok: false, reason: "low_signal" };
      }

      const topSlide = top.detailAidSlideId ? await this.content.getSlide(top.detailAidSlideId) : null;
      const canOfferRelated = !opts?.suppressRelatedSlide && (!/\btrial\b/i.test(top.topic) || /\bprogram\b/i.test(top.topic));
      const relatedAns = canOfferRelated
        ? ranked.answers.find((a, i) => i > 0 && a.detailAidSlideId && a.detailAidSlideId !== top.detailAidSlideId)
        : undefined;
      const relatedSlide = relatedAns?.detailAidSlideId ? await this.content.getSlide(relatedAns.detailAidSlideId) : null;
      const slideTitle = topSlide?.title ?? topSlide?.label;
      const relatedTitle = relatedSlide?.title ?? relatedSlide?.label;
      const priorEvents = await this.audit.forSession(ctx.sessionId);
      const disclosureGiven = disclosureAlreadyGiven(priorEvents);
      const steeringGuidance = (opts?.steering?.styleGuidance ?? []).filter(
        (g) => !disclosureGiven || !/disclos|investigational|not fda/i.test(g),
      );
      const guidance = [
        ...(opts?.coaching ?? []),
        ...steeringGuidance,
        ...slideGuidance(slideTitle, relatedTitle),
        ...antiRepeatGuidance(priorEvents),
      ];
      const started = Date.now();
      const result = await withTimeout(
        activeComposer.compose({
          question: ctx.text,
          blocks: answerBlocks,
          guidance,
          alreadyDisclosed: disclosureGiven,
          maxTokens: opts?.composerMaxTokens,
          sessionId: ctx.sessionId,
        }),
        composerTimeoutMs,
        "composer_timeout",
      );
      if (result.truncated) return { ok: false, reason: "composer_output_truncated" };
      return {
        ok: true,
        text: result.text,
        latencyMs: result.latencyMs,
        wallMs: Date.now() - started,
        answerIds: answerBlocks.map((a) => String(a.id)),
        topId: String(top.id),
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "speculative_compose_error" };
    }
  }

  private async finalize(
    ctx: TurnContext,
    r: PolicyRoute,
    classification: ReturnType<typeof classify>,
    responseText: string,
    sourceIds: string[],
    isiAttached: boolean,
    requiredSafetyText: string | undefined,
    followUpType: FollowUpType | undefined,
    detailAidSlideId: string | undefined,
    preview: boolean,
    followUpSuggestion?: FollowUpSuggestion,
  ): Promise<TurnOutput> {
    const decision = complianceGate({
      responseText,
      classification,
      sourceIds,
      isiAttached,
      requiredSafetyText,
      route: r,
    });
    await this.audit.record(ctx.sessionId, "compliance_decision", { ...decision, route: r });

    // Fail safe: a blocked response is never spoken; the HCP gets the fallback.
    const finalText = decision.decision === "approved" ? responseText : SAFE_FALLBACK;
    await this.audit.record(ctx.sessionId, "response_output", {
      route: r,
      text: finalText,
      sourceIds,
      ...(decision.decision === "approved" && followUpSuggestion?.sourceId ? { suggestedFollowUpSourceId: followUpSuggestion.sourceId } : {}),
      ...(decision.decision === "approved" && followUpSuggestion?.slideId ? { suggestedFollowUpSlideId: followUpSuggestion.slideId } : {}),
    });

    // Rehearsal/coaching preview never enqueues real follow-up / CRM work.
    if (followUpType && !preview) {
      const task = await this.followups.create({
        hcpId: ctx.hcpId,
        type: followUpType,
        sourceSessionId: ctx.sessionId,
      });
      await this.audit.record(ctx.sessionId, "follow_up_created", { followUpId: task.id, type: followUpType });
    }

    return {
      route: r,
      responseText: finalText,
      sourceIds,
      isiAttached,
      decision: decision.decision,
      reasons: decision.reasons,
      followUpType,
      detailAidSlideId: decision.decision === "approved" ? detailAidSlideId : undefined,
    };
  }

  private async firstSafetyStatement(): Promise<SafetyStatement | undefined> {
    return this.content.latestActiveSafetyStatement();
  }

  /** Bias a bare follow-up ("show me the slides") toward the topic just discussed: prepend the most
   *  recently-answered approved topic so retrieval surfaces the RELEVANT slide. Best-effort — any
   *  gap (no prior answer, lookup error) falls back to the raw text. */
  private async contextualRetrievalText(ctx: TurnContext): Promise<string> {
    try {
      const prior = await this.audit.forSession(ctx.sessionId);
      const answered = [...prior]
        .reverse()
        .filter((e) => e.type === "response_output" && Array.isArray(e.payload.sourceIds) && (e.payload.sourceIds as string[]).length > 0);
      // Bias to the last SUBSTANTIVE topic, skipping the contact/handoff answer. Otherwise, once the
      // rep answered "connect with a person" once, every short follow-up ("yeah sure", "show me the
      // slides") re-biased to contact and it never recovered — a self-reinforcing loop.
      const isRouting = (topic: string) => /contact|medical information|connect with|handoff/i.test(topic);
      if (isPureAcceptance(ctx.text)) {
        for (const e of answered) {
          const offeredId = typeof e.payload.suggestedFollowUpSourceId === "string" ? e.payload.suggestedFollowUpSourceId : undefined;
          const answer = offeredId ? await this.content.getAnswer(asId<"approved_answer_id">(offeredId) as ApprovedAnswerId) : null;
          if (answer && !isRouting(answer.topic)) return `${answer.topic} ${ctx.text}`;
        }
      }
      let topic: string | undefined;
      for (const e of answered) {
        const id = (e.payload.sourceIds as string[])[0];
        const answer = id ? await this.content.getAnswer(asId<"approved_answer_id">(id) as ApprovedAnswerId) : null;
        if (answer && !isRouting(answer.topic)) { topic = answer.topic; break; }
      }
      if (!topic) {
        // No prior real topic yet (e.g. "show me the slides" as the first thing said) → seed with the
        // deck's lead approved answer so it opens with a real overview instead of bouncing to contact.
        const active = (await this.content.listAnswers()).find((a) => a.mlr.status === "active" && !isRouting(a.topic));
        topic = active?.topic;
      }
      return topic ? `${topic} ${ctx.text}` : ctx.text;
    } catch {
      return ctx.text;
    }
  }
}
