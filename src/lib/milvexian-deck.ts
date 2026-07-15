/**
 * The Milvexian detail aid — the single source of truth for the approved,
 * NON-PROMOTIONAL deck the AI rep can show an HCP. Structured so it renders as
 * (a) a real .pptx (scripts/gen-milvexian-deck.mjs → public/decks/milvexian.pptx)
 * and (b) branded slides in the preview / session recording (SlideView).
 *
 * Content rules (see CLAUDE.md): investigational compound — no efficacy, dosing,
 * safety, comparative, or promotional claims. Mechanism/program/status only, plus
 * verbatim ISI and Medical-Information routing.
 */

// The rep's opening AI + investigational disclosure (matches the Tavus replica's
// custom greeting). Shown as the first caption/transcript line in every view.
export const REP_GREETING = "Hello, doctor. I'm an AI representative for Milvexian, an investigational compound from J&J. I can share publicly-available information and connect you with Medical Information for anything clinical.";

export interface DeckSlide {
  /** Stable id — matches the approved-answer detailAidSlideId where relevant. */
  id: string;
  kind: "title" | "content" | "isi" | "contact";
  label: string;
  title: string;
  subtitle?: string;
  bullets?: string[];
  /** Footer disclosure shown on every slide. */
  footnote?: string;
}

export const MILVEXIAN_BRAND = {
  name: "Milvexian",
  sponsor: "Johnson & Johnson · in collaboration with Bristol Myers Squibb",
  // Clinical, professional palette — deep navy + a restrained red accent.
  navy: "0B2E63",
  ink: "12233B",
  red: "C8102E",
  slate: "5B6B7F",
  mist: "EAF0F7",
  paper: "FFFFFF",
};

const DISCLOSURE =
  "Investigational — not approved by the FDA or any regulatory authority. Non-promotional; for healthcare professionals.";

// NOTE: slide selection is NO LONGER guessed from reply text. The rep surfaces the
// approved answer's own `detailAidSlideId` (source-driven), which the turn records and
// the replay/live views read directly — brand-agnostic and exact. (Removed slideForText.)

export const MILVEXIAN_DECK: DeckSlide[] = [
  {
    id: "slide_title",
    kind: "title",
    label: "Title",
    title: "Milvexian",
    subtitle: "Investigational Oral Factor XIa (FXIa) Inhibitor",
    bullets: [MILVEXIAN_BRAND.sponsor, "LIBREXIA Phase 3 Program · Cardiovascular"],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_moa",
    kind: "content",
    label: "Mechanism",
    title: "Mechanism of action",
    subtitle: "Selective inhibition of Factor XIa",
    bullets: [
      "Milvexian is an investigational, orally administered small-molecule inhibitor of Factor XIa (FXIa).",
      "FXIa sits in the intrinsic (contact) coagulation pathway, upstream of thrombin generation.",
      "The scientific hypothesis under study: uncoupling pathological thrombosis from protective hemostasis.",
      "Mechanistic overview only — efficacy and safety have not been established.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_program",
    kind: "content",
    label: "LIBREXIA program",
    title: "The LIBREXIA Phase 3 program",
    subtitle: "The most comprehensive FXIa program to date — three cardiovascular indications",
    bullets: [
      "Approximately 50,000 participants across three event-driven Phase 3 trials.",
      "LIBREXIA-STROKE — secondary prevention of ischemic stroke.",
      "LIBREXIA-ACS — acute coronary syndrome.",
      "LIBREXIA-AF — atrial fibrillation.",
      "Conducted by Johnson & Johnson in collaboration with Bristol Myers Squibb; publicly disclosed information only.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_af",
    kind: "content",
    label: "LIBREXIA-AF",
    title: "LIBREXIA-AF",
    subtitle: "Atrial fibrillation — active-controlled vs. apixaban",
    bullets: [
      "Phase 3, randomized, double-blind, active-controlled trial in atrial fibrillation or flutter.",
      "Comparator: apixaban. Approximately 15,500 participants.",
      "Studied regimen: milvexian 100 mg twice daily (investigational — not a recommended dose).",
      "Ongoing; topline data anticipated in 2026. Comparative conclusions are not yet available.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_acs",
    kind: "content",
    label: "LIBREXIA-ACS",
    title: "LIBREXIA-ACS",
    subtitle: "Acute coronary syndrome — placebo-controlled",
    bullets: [
      "Phase 3, randomized, double-blind, placebo-controlled trial after a recent acute coronary syndrome.",
      "Added to standard antiplatelet therapy; approximately 16,000 participants.",
      "Studied regimen: milvexian 25 mg twice daily (investigational).",
      "Enrollment discontinued in November 2025 after a pre-planned interim futility analysis; no new safety concerns identified.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_stroke",
    kind: "content",
    label: "LIBREXIA-STROKE",
    title: "LIBREXIA-STROKE",
    subtitle: "Secondary stroke prevention",
    bullets: [
      "Phase 3 trial for secondary prevention after an acute ischemic stroke or high-risk TIA.",
      "Studied regimen: milvexian 25 mg twice daily (investigational).",
      "Ongoing; topline data anticipated in 2026.",
      "Publicly disclosed program information only; efficacy and safety not established.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_status",
    kind: "content",
    label: "Development status",
    title: "Development status",
    subtitle: "Investigational compound",
    bullets: [
      "Received U.S. FDA Fast Track designation for disclosed indications.",
      "Not approved by the FDA or any regulatory authority for any use.",
      "Safety and efficacy have not been established.",
      "Clinical specifics (dosing, titration, comparative data) are routed to Medical Information.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_isi",
    kind: "isi",
    label: "Important Safety Information",
    title: "Important Safety Information",
    bullets: [
      "Milvexian is an investigational compound not approved by the FDA or any regulatory authority; its safety and efficacy have not been established.",
      "This information is non-promotional and intended for healthcare professionals.",
      "Adverse events should be reported to Pharmacovigilance.",
      "Clinical questions can be directed to Medical Information.",
    ],
    footnote: DISCLOSURE,
  },
  {
    id: "slide_contact",
    kind: "contact",
    label: "Medical Information",
    title: "Connect with a person",
    subtitle: "The AI rep routes anything clinical",
    bullets: [
      "Clinical / off-label questions → Medical Information & MSL.",
      "Suspected adverse events → Pharmacovigilance (safety desk).",
      "Request a human representative at any time.",
    ],
    footnote: DISCLOSURE,
  },
];
