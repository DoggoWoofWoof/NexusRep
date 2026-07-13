/**
 * Response builder (brief §21 Stages 3–4; PDF §7 "Response Builder").
 *
 * Composes the rep's answer from APPROVED BLOCKS ONLY plus fixed, non-medical
 * controlled transitions. It never generates a medical/efficacy/safety claim —
 * it concatenates verbatim approved text and (when required) verbatim ISI, and
 * surfaces which detail-aid slide to display (the "detail-aid tool call").
 */

import type { ApprovedAnswerId, DetailAidSlideId } from "@lib/ids";
import type { ApprovedAnswer, SafetyStatement } from "./types";

export interface BuiltResponse {
  text: string;
  sourceIds: ApprovedAnswerId[];
  detailAidSlideId?: DetailAidSlideId;
  isiAppended: boolean;
}

/**
 * Small set of natural, CLAIM-FREE openers — the human way a rep eases into an answer
 * and gestures at the detail aid on screen ("sure, take a look here"). They carry no
 * medical/efficacy/safety content, so they are safe controlled framing, NOT a generated
 * claim. One is picked deterministically per answer so every spoken word stays auditable
 * and the transcript reproducible. They're intentionally free of product keywords so they
 * never skew which slide `slideForText` shows.
 *
 * Replaces the old "Per the approved information:" prefix — repeating a bureaucratic
 * preamble on every line read robotically, and the greeting already tells the HCP the
 * rep shares publicly-available information.
 */
const OPENERS = [
  "Sure — let me walk you through this.",
  "Happy to walk you through this.",
  "Good question.",
  "Of course.",
  "Here's what I can share on that:",
];

/** Deterministic pick from a list — same seed → same (auditable, reproducible) choice. */
function pick<T>(list: T[], seed: string): T {
  let h = 7; // seed chosen so the demo's answers each get a distinct choice (no repeats back-to-back)
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length]!;
}

/** Deterministic opener pick: the same answer always yields the same (auditable) lead-in. */
function openerFor(seed: string): string {
  return pick(OPENERS, seed);
}

/**
 * Natural, CLAIM-FREE ways a human rep points at the detail aid MID-answer ("you can see
 * this on the … slide"). They carry NO medical/efficacy/safety content — they are controlled
 * framing that references the on-screen slide, NOT a generated claim — so they pass the gate
 * exactly like the openers do. Placed AFTER the approved body so the slide changes as the rep
 * gets to it (not on the first word). Deterministic pick keeps transcripts reproducible.
 */
const SLIDE_CUES = [
  "You can see this on the {slide} slide I've put up on your screen.",
  "You can look at the {slide} slide here, where the same approved points are laid out.",
  "I've pulled up the {slide} slide here so you can follow along.",
  "That's all laid out on the {slide} slide on your screen now.",
  "Take a look at the {slide} slide I'm showing — it walks through the same points.",
];

/** How a rep gestures at a SECOND relevant slide — using more of the deck, not just page one. */
const RELATED_CUES = [
  " There's a bit more on the {slide} slide too, if that's useful.",
  " I can also point you to the {slide} slide for the fuller picture.",
  " If you want more context, the {slide} slide is the next place I'd go.",
];

/** Lower-case a slide title for mid-sentence flow, but keep ALL-CAPS tokens (program acronyms, FDA).
 *  Strips a leading article so "the {slide} slide" never reads "the the … slide". */
function niceSlide(title: string): string {
  return title
    .replace(/^(the|a|an)\s+/i, "")
    .split(" ")
    .map((w) => (/[A-Z]{2,}/.test(w) ? w : w.toLowerCase()))
    .join(" ")
    .trim();
}

/**
 * Build the human "look at the … slide" reference woven after an approved answer. Returns "" when
 * there is no slide to show, so routed/refusal turns stay clean. `slideTitle` is the on-screen
 * slide's display title; `relatedTitle` (optional) points the HCP at a second relevant slide.
 */
export function slideReference(opts: { seed: string; slideTitle?: string; relatedTitle?: string }): string {
  const title = opts.slideTitle?.trim();
  if (!title) return "";
  const lead = pick(SLIDE_CUES, opts.seed).replace("{slide}", niceSlide(title));
  const related = opts.relatedTitle?.trim();
  const rel = related && related !== title ? pick(RELATED_CUES, `${opts.seed}~rel`).replace("{slide}", niceSlide(related)) : "";
  return ` ${lead}${rel}`;
}

export function buildApprovedResponse(
  answers: ApprovedAnswer[],
  opts: { isi?: SafetyStatement; includeIsi: boolean; slideTitle?: string; relatedTitle?: string; seed?: string },
): BuiltResponse | null {
  const top = answers[0];
  if (!top) return null; // caller fails safe to a fallback

  const seed = opts.seed ?? String(top.id);
  const ref = slideReference({ seed, slideTitle: opts.slideTitle, relatedTitle: opts.relatedTitle });
  let text = `${openerFor(seed)} ${top.text}${ref}`;
  let isiAppended = false;
  if (opts.includeIsi && opts.isi) {
    text = `${text}\n\nImportant Safety Information: ${opts.isi.text}`;
    isiAppended = true;
  }

  return {
    text,
    sourceIds: [top.id],
    detailAidSlideId: top.detailAidSlideId,
    isiAppended,
  };
}
