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
import { classify, complianceGate, route, validateGrounding, type PolicyRoute, type RiskClassification, isiAlreadyDelivered, stripEmbeddedIsi } from "@modules/compliance";
import type { RetrievalService } from "@modules/retrieval";
import { buildApprovedResponse, type ApprovedAnswer, type ContentService, type GroundedComposer, type SafetyStatement } from "@modules/content";
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

const SAFE_FALLBACK =
  "I want to make sure I only share approved information. Let me connect you with someone who can help.";
const COMPOSER_TIMEOUT_MS = 2500;

// A short message that references the slides/deck or asks to continue but names NO topic of its
// own — its meaning depends on what was just discussed ("show me the slides", "tell me more",
// "walk me through it", "keep going"). Retrieval biases these toward the prior turn's topic.
const FOLLOWUP_RE = /\b(show me|show us|pull up|walk me through|the slides?|the deck|the presentation|the detail aid|tell me more|more on (that|this|it)|what about (that|this|it)|continue|keep going|go on|next|yes|yeah|yep|sure|okay|ok|please|go ahead|sounds good|absolutely|definitely)\b/i;

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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("composer_timeout")), ms);
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
    const retrievalPromise = retrievalTextPromise
      .then((text) =>
        this.retrieval.retrieveApproved({
          text,
          context: { audience: ctx.audience, indication: ctx.indication, market: ctx.market },
        }),
      )
      .then(
        (result) => ({ result, latencyMs: Date.now() - retrievalStarted }),
        (error: unknown) => ({ error, latencyMs: Date.now() - retrievalStarted }),
      );
    const classificationStarted = Date.now();
    const classification = await (opts?.classify ?? this.classifier)(ctx.text);
    await this.audit.record(ctx.sessionId, "classification", {
      ...classification,
      latencyMs: Date.now() - classificationStarted,
      turnElapsedMs: Date.now() - turnStarted,
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
    const blockedTopics = opts?.steering?.blockedTopics ?? [];
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

    if (r === "approved_answer") {
      const retrievalSettled = await retrievalPromise;
      if ("error" in retrievalSettled) {
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
      const leadTopics = opts?.steering?.leadTopics ?? [];
      if (leadTopics.length && result.answers.length > 1) {
        const led = result.answers.filter((a) => leadTopics.some((t) => matchesTopic(`${a.topic} ${a.text}`, t)));
        if (led.length) {
          const rest = result.answers.filter((a) => !led.includes(a));
          result.answers = [...led, ...rest];
          await this.audit.record(ctx.sessionId, "coaching_rule_applied", { rule: "conversation_ordering", led: led.map((a) => a.id) });
        }
      }
      const top = result.answers[0];
      if (!top) {
        // No approved block → fail safe to fallback (content gap signal).
        return this.finalize(ctx, "fallback", classification, SAFE_FALLBACK, [], false, undefined, undefined, undefined, opts?.preview ?? false);
      }
      // Resolve the on-screen slide titles so the rep can reference the detail aid the way a
      // person does ("you can see this on the … slide") and gesture at a SECOND relevant slide —
      // so the whole deck gets used across a conversation, not just the first page.
      const topSlide = top.detailAidSlideId ? await this.content.getSlide(top.detailAidSlideId) : null;
      const relatedAns = result.answers.find((a, i) => i > 0 && a.detailAidSlideId && a.detailAidSlideId !== top.detailAidSlideId);
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
      const disclosureGiven = priorEvents.some((e) => e.type === "response_output" && typeof e.payload.text === "string" && (e.payload.text as string).trim().length > 0);
      // The on-screen slide is offered to the composer as a HINT so it can weave a BRIEF, varied
      // reference itself (and drop it when asked to be terse) — instead of a fixed bolt-on sentence
      // that read repetitively. Rehearsal + active persona_style coaching also flow in as guidance.
      // None of this can override grounding or the gate.
      const slideHint = slideTitle
        ? [`A detail-aid slide titled "${slideTitle}" is being shown on the doctor's screen${relatedTitle ? ` (a "${relatedTitle}" slide is also available)` : ""}. Briefly NAME the slide you're showing in one short, natural clause (e.g. "you can see this on the ${slideTitle} slide") so the doctor knows what's on screen — vary the wording and keep it to a short clause, but don't omit it unless you were explicitly asked to be terse.`]
        : [];
      const steeringGuidance = (opts?.steering?.styleGuidance ?? []).filter(
        (g) => !disclosureGiven || !/disclos|investigational|not fda/i.test(g),
      );
      // Conversation-aware de-dup across the WHOLE session (not just the last turn): show the
      // composer EVERYTHING it has already told this doctor so it answers with genuinely new
      // information or a fresh angle instead of re-stating the same few blocks. Deduped + capped so
      // the prompt stays lean. Advisory only (never overrides grounding/gate); deterministic ignores it.
      const priorReplies = priorEvents
        .filter((e) => e.type === "response_output" && typeof e.payload.text === "string")
        .map((e) => (e.payload.text as string).split(/\n\nImportant Safety Information:/)[0]!.trim())
        .filter((t) => t.length > 20);
      const covered = [...new Set(priorReplies)].slice(-8); // recent, de-duplicated
      const antiRepeat = covered.length
        ? [
            `Earlier in THIS conversation you already said:\n${covered
              .map((t, i) => `(${i + 1}) ${t.slice(0, 180)}`)
              .join("\n")}\nDon't sound repetitive: do NOT repeat an earlier answer word-for-word or open with the same phrase, and don't pad a reply with background that isn't what was asked. Restating an important or directly-relevant point is fine, but say it in DIFFERENT words and framing and lead with something new. When the approved content genuinely has nothing new to add, say so briefly and offer to go deeper rather than repeating an earlier answer verbatim.`,
          ]
        : [];
      const guidance = [...(opts?.coaching ?? []), ...steeringGuidance, ...slideHint, ...antiRepeat];
      const overrideComposer = opts?.composer;
      const activeComposer = overrideComposer !== undefined ? overrideComposer : this.composer;
      const composeFn = activeComposer?.available()
        ? (q: string, b: ApprovedAnswer[]) => activeComposer.compose({ question: q, blocks: b, guidance, safety: isi?.text, alreadyDisclosed: disclosureGiven })
        : undefined;
      // Deterministic fallback (no LLM) speaks approved text + one brief slide cue; it cannot weave,
      // so the ISI is appended verbatim below.
      const responseSeed = `${ctx.sessionId}:${ctx.text}:${priorEvents.length}:${top.id}`;
      const deterministic = () => buildApprovedResponse(result.answers, { includeIsi: false, slideTitle, seed: responseSeed })?.text ?? top.text;
      let body: string;
      if (composeFn) {
        try {
          // Deterministic backstop: whatever the model wove in, an embedded ISI copy is
          // removed — the platform alone decides when the exact ISI is appended.
          const composerStarted = Date.now();
          const composeResult = await withTimeout(composeFn(ctx.text, result.answers), COMPOSER_TIMEOUT_MS);
          const composerWallMs = Date.now() - composerStarted;
          await this.audit.record(ctx.sessionId, "response_validation", {
            action: "composer_success",
            composer: activeComposer?.name,
            latencyMs: composeResult.latencyMs,
            wallMs: composerWallMs,
            timeoutMs: COMPOSER_TIMEOUT_MS,
            turnElapsedMs: Date.now() - turnStarted,
          });
          const composed = stripSpeechMarkdown(stripEmbeddedIsi(composeResult.text.trim(), isiStatement?.text ?? ""));
          if (!composed) {
            body = deterministic();
          } else {
            // Grounding is checked against approved answer blocks only. The exact ISI is appended
            // after composition, so a model-generated safety paraphrase is not needed and cannot
            // be used to satisfy the gate.
            const groundBlocks = result.answers.map((a) => a.text);
            const grounding = validateGrounding({ answer: composed, blocks: groundBlocks });
            if (grounding.grounded) {
              body = composed; // the composer may weave the slide reference; approved ISI is appended below.
            } else {
              await this.audit.record(ctx.sessionId, "response_validation", {
                grounded: false,
                coverage: grounding.coverage,
                ungroundedNumbers: grounding.ungroundedNumbers,
                novelTokens: grounding.novelTokens.slice(0, 12),
                action: "fallback_to_approved_text",
              });
              body = deterministic();
            }
          }
        } catch (error) {
          await this.audit.record(ctx.sessionId, "response_validation", {
            action: "composer_fallback",
            reason: error instanceof Error ? error.message : "error_or_timeout",
            timeoutMs: COMPOSER_TIMEOUT_MS,
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
      sourceIds = result.answers.map((a) => a.id);
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

    return this.finalize(ctx, r, gateClassification, responseText, sourceIds, isiAttached, requiredSafetyText, followUpType, detailAidSlideId, opts?.preview ?? false);
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
    await this.audit.record(ctx.sessionId, "response_output", { route: r, text: finalText, sourceIds });

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
