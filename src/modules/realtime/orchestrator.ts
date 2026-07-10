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

import type { HcpId, SessionId } from "@lib/ids";
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

/** Intents that are clinical specifics — off-limits for an investigational product. */
const CLINICAL_SPECIFICS = new Set(["dosing", "safety", "administration", "trial_data"]);

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
    const classification = await (opts?.classify ?? this.classifier)(ctx.text);
    await this.audit.record(ctx.sessionId, "classification", { ...classification });

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
      const result = await this.retrieval.retrieveApproved({
        text: ctx.text,
        context: { audience: ctx.audience, indication: ctx.indication, market: ctx.market },
      });
      await this.audit.record(ctx.sessionId, "retrieval", {
        accepted: result.answers.map((a) => a.id),
        rejected: result.rejected,
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
        ? [`A detail-aid slide titled "${slideTitle}" is on the doctor's screen${relatedTitle ? ` (a "${relatedTitle}" slide is also available)` : ""}. You may refer to what's on screen briefly and naturally when it helps, but keep it crisp, vary the wording, and omit it when asked to be brief.`]
        : [];
      const steeringGuidance = (opts?.steering?.styleGuidance ?? []).filter(
        (g) => !disclosureGiven || !/disclos|investigational|not fda/i.test(g),
      );
      const guidance = [...(opts?.coaching ?? []), ...steeringGuidance, ...slideHint];
      const overrideComposer = opts?.composer;
      const activeComposer = overrideComposer !== undefined ? overrideComposer : this.composer;
      const composeFn = activeComposer?.available()
        ? (q: string, b: ApprovedAnswer[]) => activeComposer.compose({ question: q, blocks: b, guidance, safety: isi?.text, alreadyDisclosed: disclosureGiven }).then((r) => r.text)
        : undefined;
      // Deterministic fallback (no LLM) speaks approved text + one brief slide cue; it cannot weave,
      // so the ISI is appended verbatim below.
      const deterministic = () => buildApprovedResponse(result.answers, { includeIsi: false, slideTitle })?.text ?? top.text;
      let body: string;
      if (composeFn) {
        try {
          // Deterministic backstop: whatever the model wove in, an embedded ISI copy is
          // removed — the platform alone decides when the exact ISI is appended.
          const composed = stripEmbeddedIsi((await composeFn(ctx.text, result.answers)).trim(), isiStatement?.text ?? "");
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
        } catch {
          body = deterministic();
        }
      } else {
        body = deterministic();
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
      sourceIds = result.answers.map((a) => a.id);
      detailAidSlideId = top.detailAidSlideId;
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
      responseText = "Of course — I can arrange for a representative to contact you.";
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
}
