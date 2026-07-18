/**
 * PII / PHI redaction for the VENDOR BOUNDARY. The hard rule (brief): no patient-level data may reach
 * third-party AI/ASR/TTS vendors (Anthropic, OpenAI, Tavus). A doctor's transcribed turn can contain
 * patient identifiers, so we scrub them from the text sent to the LLM classifier + composer.
 *
 * SCOPE + HONESTY:
 *  - This is applied ONLY on the path to third parties (classifier + composer request bodies). It is
 *    deliberately NOT applied to our own session store or logs — full transcripts are kept on our side
 *    (see logger.ts) for review/debugging. Redacting for vendors, keeping full internally, is the point.
 *  - Structured identifiers (email, phone, SSN, MRN, DOB, member/policy IDs) are matched with high
 *    confidence. Un-titled free-text patient NAMES are the hard case — true PHI name detection needs
 *    NLP/NER, which is out of scope here; we catch the clear signal (a title + a capitalized name) and
 *    accept that a bare name may pass. This is defense-in-depth that materially reduces egress, NOT a
 *    guarantee of zero PHI. Clinical terms and drug/program names are intentionally left intact so the
 *    classifier/composer still work (a title is required before a name, so "Milvexian"/"Factor XIa" are
 *    never touched).
 *  - The redaction is compliance-relevant: an adverse-event or off-label signal survives redaction
 *    (only identifiers are masked, never clinical language), so routing/gating is unaffected.
 */

interface Pattern {
  readonly kind: string;
  readonly re: RegExp;
  readonly placeholder: string;
}

// Order matters: email before phone (so digits inside an address aren't half-matched); identifier
// patterns that require a keyword prefix before the looser phone/name catches.
const PATTERNS: readonly Pattern[] = [
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, placeholder: "[REDACTED_EMAIL]" },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: "[REDACTED_SSN]" },
  { kind: "mrn", re: /\b(?:MRN|medical record(?:\s*(?:number|no\.?|#))?)\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]{3,}\b/gi, placeholder: "[REDACTED_MRN]" },
  { kind: "dob", re: /\b(?:DOB|d\.o\.b\.?|date of birth|born(?:\s+on)?)\s*:?\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/gi, placeholder: "[REDACTED_DOB]" },
  { kind: "memberId", re: /\b(?:member|policy|subscriber|insurance)\s*(?:id|number|no\.?|#)?\s*[:#]\s*[A-Za-z0-9][A-Za-z0-9-]{4,}\b/gi, placeholder: "[REDACTED_MEMBER_ID]" },
  { kind: "phone", re: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, placeholder: "[REDACTED_PHONE]" },
  // Titled personal name: a courtesy/professional title immediately followed by 1–2 capitalized words.
  // The required title is what keeps clinical/product proper nouns (Milvexian, Factor XIa) safe.
  { kind: "name", re: /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g, placeholder: "[REDACTED_NAME]" },
];

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
  /** Per-kind hit counts, for observability (never contains the redacted values themselves). */
  readonly kinds: Record<string, number>;
}

export function redactPiiDetailed(input: string): RedactionResult {
  if (!input) return { text: input ?? "", count: 0, kinds: {} };
  let text = input;
  let count = 0;
  const kinds: Record<string, number> = {};
  for (const { kind, re, placeholder } of PATTERNS) {
    text = text.replace(re, () => {
      count += 1;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      return placeholder;
    });
  }
  return { text, count, kinds };
}

/** Redact patient identifiers from text bound for a third-party vendor. Returns the scrubbed text. */
export function redactPii(input: string): string {
  return redactPiiDetailed(input).text;
}
