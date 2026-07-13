/**
 * Brand profile — the single, data-driven source of everything brand/campaign
 * specific about an AI rep: identity, palette, greeting, the compliant persona
 * (system prompt / greeting / context / hotwords), the detail-aid deck, the seed
 * approved answers + ISI, the clinical context, and UI copy.
 *
 * The point of this module: onboarding a NEW brand is adding a profile here (or,
 * in production, loading one the Setup Assistant + content ingestion produced) —
 * NOT editing the engine, the routes, or the UI. Every consumer reads a
 * `BrandProfile` (server: `container.brand`; client: `/api/brand` → BrandProvider),
 * so the conversation engine, slides, persona, and chrome are all brand-agnostic.
 *
 * Milvexian is simply the first registered profile. The raw Milvexian deck/palette/
 * greeting still live in `@lib/milvexian-deck` (that file is now just this brand's
 * data); everything else about the brand is composed here.
 */

import { MILVEXIAN_DECK, MILVEXIAN_BRAND, REP_GREETING, type DeckSlide } from "@lib/milvexian-deck";

export type { DeckSlide };

/** Clinical + regulatory context that drives routing and MLR scoping. */
export interface BrandClinicalContext {
  audience: string;
  indication: string;
  market: string;
  /** Investigational compound → clinical specifics route to Medical Information. */
  investigational: boolean;
  /** Targeting inputs for the audience query — a brand that declares these never
   *  inherits another brand's specialties/indications. */
  specialties?: string[];
  diagnosisCodes?: string[];
}

/** The colours a brand's slides/chrome render with. */
export interface BrandPalette {
  navy: string;
  ink: string;
  red: string;
  slate: string;
  mist: string;
  paper: string;
}

/** The outward-facing rep persona handed to the realtime/avatar vendor (Tavus). */
export interface BrandPersona {
  /** Instruction that the vendor model speaks OUR gated text verbatim. */
  systemPrompt: string;
  /** First line the replica speaks on join (== the rep greeting). */
  customGreeting: string;
  /** Non-PHI grounding context for the vendor. */
  context: string;
  /** ASR bias words (product/program/comparator names). */
  hotwords: string[];
  language: string;
}

/** A seed approved answer + the detail-aid slide the rep shows for it. */
export interface BrandApprovedAnswer {
  id: string;
  topic: string;
  text: string;
  /** Which deck slide this answer maps to (a DeckSlide id). */
  detailAidSlideId: string;
  /** Title/label for the canonical DetailAidSlide record the container seeds. */
  slideTitle: string;
  slideLabel: string;
}

/** Which public-info topic the audience view leads with, by whitespace signal. */
export interface BrandRecommendedTopics {
  trendNegative: string;
  lowShare: string;
  default: string;
}

export interface BrandProfile {
  /** Canonical ids (cast to branded ids by the container). */
  tenantId: string;
  brandId: string;
  campaignId: string;
  aiRepId: string;
  /** Short product name shown in chrome + slide rails. */
  displayName: string;
  sponsor: string;
  /** One-line product descriptor for the HCP invite ("an investigational oral … from …"). */
  tagline: string;
  palette: BrandPalette;
  /** The rep's opening AI + investigational disclosure (all surfaces). */
  greeting: string;
  persona: BrandPersona;
  /** The detail-aid deck rendered on-screen + generated as the .pptx. */
  deck: DeckSlide[];
  deckPptxUrl: string;
  /** Campaign chrome copy for the brand console header. */
  campaign: BrandCampaign;
  clinical: BrandClinicalContext;
  /** Seed approved answers (demo). In production these come from content ingestion. */
  approvedAnswers: BrandApprovedAnswer[];
  /** Verbatim ISI, delivered when required. */
  isiText: string;
  /** Example questions offered in the HCP view. */
  tryQuestions: string[];
  /** Short talking-point labels the Setup Assistant offers (the rep's key topics). */
  talkingPoints: string[];
  recommendedTopics: BrandRecommendedTopics;
  /** Public-info topic KEYS the rep is expected to cover; "content gaps" = the uncovered ones
   *  (matched against approved-answer topics). A blank/unconfigured brand has none, so it shows
   *  zero gaps until its own content defines what to cover — never another brand's topics. */
  targetTopics?: string[];
  /**
   * Brand-specific language layered onto the engine's GENERIC clinical heuristics:
   * `productTerms` bias intent + overview detection and upload topic inference;
   * `topicSynonyms` improve retrieval re-rank + ingest topic matching. A new brand
   * ships its own lexicon in its profile — the engine files stay brand-free.
   */
  lexicon: {
    productTerms: string[];
    topicSynonyms: Record<string, string[]>;
  };
}

/** Client-safe projection sent to the browser via /api/brand (no seed answers/persona). */
export interface PublicBrand {
  displayName: string;
  sponsor: string;
  tagline: string;
  palette: BrandPalette;
  greeting: string;
  deck: DeckSlide[];
  deckPptxUrl: string;
  campaign: BrandCampaign;
  /** Persona language word ("english") — drives the doctor view's ASR/TTS locale. */
  language: string;
  tryQuestions: string[];
  talkingPoints: string[];
  indication: string;
  investigational: boolean;
  /** Brand product/program names — client-side overview detection + copy. */
  productTerms: string[];
  /** Persona voice tone (professional / warm / clinical) — drives the doctor view's TTS
   *  delivery so the tone chosen in the Studio is heard by doctors too. Set by the /api/brand
   *  route from the live persona (not part of the static profile). */
  voiceStyle?: string;
  /** Video-off voice chosen in the Agent gallery (an OpenAI voice id). When set it's the rep's voice
   *  when video is off (and, with voiceWholeConvo, for the whole conversation). null = app default. */
  voiceId?: string | null;
  /** When true, voiceId is used for the WHOLE conversation (video on too), not just video-off. */
  voiceWholeConvo?: boolean;
}

export interface BrandCampaign {
  title: string;
  subtitle: string;
  /** When set, "Day N of M" is COMPUTED from the clock and appended to the subtitle —
   *  a frozen day counter in copy rots. NEXUSREP_DEMO_DATE pins "today" (demos, visual tests). */
  startDate?: string;
  lengthDays?: number;
}

function withCampaignProgress(c: BrandCampaign): BrandCampaign {
  if (!c.startDate || !c.lengthDays) return c;
  const today = process.env.NEXUSREP_DEMO_DATE ? new Date(process.env.NEXUSREP_DEMO_DATE) : new Date();
  const day = Math.min(Math.max(Math.floor((today.getTime() - new Date(c.startDate).getTime()) / 86_400_000) + 1, 1), c.lengthDays);
  return { ...c, subtitle: `${c.subtitle} · Day ${day} of ${c.lengthDays}` };
}

export function toPublicBrand(p: BrandProfile): PublicBrand {
  return {
    displayName: p.displayName,
    sponsor: p.sponsor,
    tagline: p.tagline,
    palette: p.palette,
    greeting: p.greeting,
    deck: p.deck,
    deckPptxUrl: p.deckPptxUrl,
    campaign: withCampaignProgress(p.campaign),
    language: p.persona.language,
    tryQuestions: p.tryQuestions,
    talkingPoints: p.talkingPoints,
    indication: p.clinical.indication,
    investigational: p.clinical.investigational,
    productTerms: p.lexicon.productTerms,
  };
}

/**
 * A BLANK profile for "clean" accounts that build a rep from scratch — no Milvexian brand, deck,
 * cohort, seeded answers, or campaign. Only the mandatory AI/Medical-Information disclosure stays
 * in the greeting/persona. The Setup Assistant + content ingestion fill the rest.
 */
export const BLANK_PROFILE: BrandProfile = {
  tenantId: "tenant_blank",
  brandId: "brand_blank",
  campaignId: "camp_blank",
  aiRepId: "airep_blank",
  displayName: "Your AI Rep",
  sponsor: "",
  tagline: "an AI representative",
  palette: { navy: "#04307a", ink: "#1e2535", red: "#dc2626", slate: "#64748b", mist: "#eef2f8", paper: "#ffffff" },
  greeting: "Hello, doctor. I'm an AI representative. I share only approved information and connect you with Medical Information for any clinical question.",
  persona: {
    systemPrompt: "You are an AI representative. Speak ONLY the approved text provided to you; never add a fact, number, dose, or claim. Disclose that you are AI and route any clinical question to Medical Information.",
    customGreeting: "",
    context: "No product is configured yet. No patient-level data.",
    hotwords: [],
    language: "english",
  },
  deck: [],
  deckPptxUrl: "",
  campaign: { title: "New AI Rep", subtitle: "Not configured yet" },
  clinical: { audience: "healthcare professionals", indication: "", market: "", investigational: true, specialties: [], diagnosisCodes: [] },
  approvedAnswers: [],
  isiText: "",
  tryQuestions: [],
  talkingPoints: [],
  recommendedTopics: { trendNegative: "", lowShare: "", default: "" },
  lexicon: { productTerms: [], topicSynonyms: {} },
};

/**
 * The J&J Milvexian / LIBREXIA-cardiology profile — the first registered brand.
 * Adding another brand = another BrandProfile object registered in BRANDS below.
 */
export const MILVEXIAN_PROFILE: BrandProfile = {
  tenantId: "tenant_jnj",
  brandId: "brand_milvexian",
  campaignId: "camp_librexia_cardiology",
  aiRepId: "airep_milvexian",
  displayName: MILVEXIAN_BRAND.name,
  sponsor: MILVEXIAN_BRAND.sponsor,
  tagline: "an investigational oral Factor XIa inhibitor from J&J",
  palette: {
    navy: MILVEXIAN_BRAND.navy,
    ink: MILVEXIAN_BRAND.ink,
    red: MILVEXIAN_BRAND.red,
    slate: MILVEXIAN_BRAND.slate,
    mist: MILVEXIAN_BRAND.mist,
    paper: MILVEXIAN_BRAND.paper,
  },
  greeting: REP_GREETING,
  persona: {
    systemPrompt:
      "You are an AI representative for Milvexian, an investigational compound from J&J. You share only publicly-disclosed information and route any clinical question to Medical Information. Your replies are produced by an external compliance system; speak them verbatim.",
    customGreeting: REP_GREETING,
    context: "Product: Milvexian (investigational Factor XIa inhibitor). Audience: cardiology. No patient-level data.",
    hotwords: ["Milvexian", "LIBREXIA", "Factor XIa", "apixaban"],
    language: "english",
  },
  deck: MILVEXIAN_DECK,
  deckPptxUrl: "/decks/milvexian.pptx",
  campaign: {
    title: "Milvexian — LIBREXIA Whitespace Activation",
    subtitle: "Factor XIa inhibitor · cardiology · US LIBREXIA campaign", startDate: "2026-06-23", lengthDays: 92,
  },
  clinical: {
    audience: "cardiology",
    indication: "anticoagulation",
    market: "US",
    investigational: true,
    // LIBREXIA targeting: cardiology-family specialties treating ACS (I21/I24),
    // atrial fibrillation (I48) and ischemic stroke (I63).
    specialties: ["Cardiology", "Interventional Cardiology", "Cardiac Electrophysiology", "Vascular Neurology"],
    diagnosisCodes: ["I48", "I21", "I24", "I63"],
  },
  approvedAnswers: [
    {
      id: "ans_title",
      topic: "overview",
      text: "Milvexian is presented as an investigational oral Factor XIa inhibitor from J&J in collaboration with Bristol Myers Squibb, within the LIBREXIA Phase 3 cardiovascular program.",
      detailAidSlideId: "slide_title",
      slideTitle: "Milvexian",
      slideLabel: "Title",
    },
    {
      id: "ans_moa",
      topic: "mechanism",
      text: "Milvexian is an investigational, orally administered Factor XIa (FXIa) inhibitor being studied as an anticoagulant. It is not approved by the FDA or any regulatory authority.",
      detailAidSlideId: "slide_moa",
      slideTitle: "Mechanism of action",
      slideLabel: "Mechanism",
    },
    {
      id: "ans_program",
      topic: "program",
      text: "Milvexian is being evaluated in the Phase 3 LIBREXIA program across three indications under study: secondary prevention of ischemic stroke, acute coronary syndrome (ACS), and atrial fibrillation.",
      detailAidSlideId: "slide_program",
      slideTitle: "LIBREXIA Phase 3 program",
      slideLabel: "LIBREXIA program",
    },
    {
      id: "ans_status",
      topic: "status",
      text: "Milvexian is investigational and not FDA approved. It has received U.S. FDA Fast Track designation for all three indications under evaluation in the LIBREXIA program.",
      detailAidSlideId: "slide_status",
      slideTitle: "Development status",
      slideLabel: "Development status",
    },
    {
      id: "ans_isi",
      topic: "important safety information",
      text: "Milvexian is an investigational compound not approved by the FDA or any regulatory authority; its safety and efficacy have not been established. This information is non-promotional and intended for healthcare professionals. Clinical questions can be directed to Medical Information.",
      detailAidSlideId: "slide_isi",
      slideTitle: "Important Safety Information",
      slideLabel: "Important Safety Information",
    },
    {
      id: "ans_contact",
      topic: "medical information contact",
      text: "Clinical or off-label questions should be routed to Medical Information or an MSL, suspected adverse events should be routed to Pharmacovigilance, and a human representative can be requested at any time.",
      detailAidSlideId: "slide_contact",
      slideTitle: "Connect with a person",
      slideLabel: "Medical Information",
    },
  ],
  isiText:
    "Milvexian is an investigational compound not approved by the FDA or any regulatory authority; its safety and efficacy have not been established. This information is non-promotional and intended for healthcare professionals. Clinical questions can be directed to Medical Information.",
  tryQuestions: [
    "What is Milvexian and how does it work?",
    "What's the LIBREXIA program?",
    "What's the recommended dose?",
    "How does it compare to apixaban?",
    "Can I use it off-label?",
  ],
  talkingPoints: ["mechanism of action", "the LIBREXIA program", "FDA status"],
  targetTopics: ["mechanism", "program", "status"],
  recommendedTopics: {
    trendNegative: "Development & FDA status",
    lowShare: "Milvexian mechanism (FXIa)",
    default: "LIBREXIA program overview",
  },
  // The engine's classifiers/retrieval/ingest are brand-free; this lexicon is where
  // Milvexian-specific vocabulary lives (moved out of the engine code files).
  lexicon: {
    productTerms: ["milvexian", "librexia", "factor xia", "fxia", "apixaban"],
    topicSynonyms: {
      mechanism: ["factor", "xia", "fxia", "pathway", "thrombosis", "anticoagulant"],
      program: ["librexia", "acs", "af", "stroke", "atrial", "fibrillation"],
    },
  },
};

/**
 * Merge a brand user's Setup Assistant answers over the base profile, so configuring the
 * rep BY CHATTING actually changes it — no code edits. `answers` is keyed by setup-question
 * key (brand, indication, greeting, disclosure, talking_points, target_audience, …). Identity
 * comes from chat; the persona system-prompt + hotwords are RE-DERIVED from the resolved
 * identity (never user free-text) so the "speak approved text verbatim" contract is preserved.
 * Content (deck / approved answers / ISI) is NOT set here — that comes from content upload + MLR.
 */
export function resolveBrandProfile(base: BrandProfile, answers: Record<string, string | null | undefined>): BrandProfile {
  const get = (k: string) => { const v = answers[k]; return typeof v === "string" && v.trim() ? v.trim() : undefined; };
  const list = (k: string) => get(k)?.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const displayName = get("brand") ?? base.displayName;
  const indication = get("indication") ?? base.clinical.indication;
  const audience = get("target_audience") ?? base.clinical.audience;
  const greeting = get("greeting") ?? get("disclosure") ?? base.greeting;
  const talkingPoints = list("talking_points") ?? base.talkingPoints;
  const sponsor = get("sponsor") ?? base.sponsor;
  const tagline = get("tagline") ?? base.tagline;
  const tryQuestions = list("try_questions") ?? base.tryQuestions;
  const extraHotwords = list("hotwords") ?? [];
  // Targeting + campaign progress are brand config too — editable by chatting, like
  // everything else. Malformed dates/lengths are ignored (the base profile stands).
  const specialties = list("target_specialties") ?? base.clinical.specialties;
  const diagnosisCodes = list("diagnosis_codes") ?? base.clinical.diagnosisCodes;
  const startRaw = get("campaign_start");
  const startDate = startRaw && !Number.isNaN(new Date(startRaw).getTime()) ? startRaw : base.campaign.startDate;
  const lengthRaw = Number(get("campaign_length"));
  const lengthDays = Number.isFinite(lengthRaw) && lengthRaw > 0 ? Math.floor(lengthRaw) : base.campaign.lengthDays;
  const investigational = base.clinical.investigational;
  return {
    ...base,
    displayName,
    sponsor,
    tagline,
    greeting,
    talkingPoints,
    tryQuestions,
    clinical: { ...base.clinical, indication, audience, specialties, diagnosisCodes },
    campaign: { ...base.campaign, startDate, lengthDays },
    // Chat-supplied hotwords also become product terms so intent/overview detection
    // and ingestion topic hints track whatever the brand user typed — no code edits.
    lexicon: {
      ...base.lexicon,
      productTerms: Array.from(new Set([...base.lexicon.productTerms, displayName.toLowerCase(), ...extraHotwords.map((h) => h.toLowerCase())])),
    },
    persona: {
      ...base.persona,
      // Re-derived from the resolved identity (not user prose) — keeps the verbatim contract.
      systemPrompt: `You are an AI representative for ${displayName}${investigational ? ", an investigational compound" : ""}. You share only publicly-disclosed information and route any clinical question to Medical Information. Your replies are produced by an external compliance system; speak them verbatim.`,
      customGreeting: greeting,
      context: `Product: ${displayName}. Audience: ${audience}. No patient-level data.`,
      hotwords: Array.from(new Set([displayName, ...extraHotwords, ...base.persona.hotwords])),
    },
  };
}

/**
 * Derive "Try asking" suggestions from the LIVE approved knowledge base, so the doctor
 * view suggests questions the rep can actually answer — dynamically, from whatever
 * content cleared MLR (seeded deck or uploads), never a static list that can drift.
 * Topics come from the approved answers; known topics get a natural phrasing, unknown
 * ones (e.g. from an uploaded FAQ) get a safe generic phrasing.
 */
export function tryQuestionsFromKnowledge(topics: string[], displayName: string, max = 4): string[] {
  // Word-anchored so a novel topic never false-matches (e.g. "reimbursement_pathways"
  // must NOT read as mechanism) — unknown topics fall through to the generic phrasing.
  const templates: [RegExp, (n: string, t: string) => string][] = [
    [/\b(mechanism|moa)\b/, (n) => `How does ${n} work?`],
    [/\b(trial|program|phase|efficacy|endpoint|study)\b/, () => `What is the clinical program studying?`],
    [/\b(dosing|dose|administration|regimen)\b/, () => `What dosing is being studied?`],
    [/\b(safety|isi|adverse|warning)s?\b/, () => `What safety information should I be aware of?`],
    [/\b(status|approval|regulatory|development)\b/, (n) => `What is ${n}'s development status?`],
    [/\b(access|support|enrollment)\b/, () => `Is there an access or support program?`],
    [/\b(indication|population|patient)s?\b/, (n) => `Who is ${n} being studied for?`],
    [/\b(storage|handling|stability)\b/, (n, t) => `What is the ${n} ${t.replace(/[_-]+/g, " ")} guidance?`],
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of topics) {
    const topic = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
    if (!topic || topic === "overview" || topic === "escalation" || topic === "contact") continue; // covered by the pitch / routing
    const template = templates.find(([re]) => re.test(topic));
    const q = template ? template[1](displayName, topic) : `What does the approved information cover on ${topic}?`;
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/** A live approved-content slide (from upload → MLR approval) to surface in the deck. */
export interface LiveDeckInput {
  id: string;
  title: string;
  label: string;
  position?: number;
  /** The approved answer text backing this slide — rendered as the slide bullets. */
  text: string;
}

/**
 * Merge the profile's authored deck with LIVE approved content (uploads that cleared MLR),
 * so a brand configured purely by chat + upload gets a real on-screen deck — the same rich
 * experience the seeded demo brand has, with zero code. Profile slides win on id collision
 * (they carry richer, hand-authored bullets); live slides append in deck order.
 */
export function mergeLiveDeck(profileDeck: DeckSlide[], live: LiveDeckInput[]): DeckSlide[] {
  const known = new Set(profileDeck.map((s) => s.id));
  const footnote = profileDeck[0]?.footnote;
  const extras: DeckSlide[] = live
    .filter((s) => !known.has(s.id))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => ({
      id: s.id,
      kind: "content" as const,
      label: s.label,
      title: s.title,
      // Bullets from the approved text (sentence split, capped) — never generated copy.
      bullets: s.text
        .split(/(?<=[.!?])\s+/)
        .map((b) => b.trim())
        .filter(Boolean)
        .slice(0, 5),
      ...(footnote ? { footnote } : {}),
    }));
  return [...profileDeck, ...extras];
}

/** Flatten a Setup Assistant draft's fields into a {questionKey: value} map for resolveBrandProfile. */
export function setupAnswersOf(draft: { sections: { fields: { key: string; value: string | null }[] }[] } | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of draft?.sections ?? []) for (const f of s.fields) if (f.value) out[f.key] = f.value;
  return out;
}

const BRANDS: Record<string, BrandProfile> = {
  [MILVEXIAN_PROFILE.brandId]: MILVEXIAN_PROFILE,
};

/** The brand the demo runs as. A multi-brand deployment would resolve per tenant/session. */
export const ACTIVE_BRAND_ID = MILVEXIAN_PROFILE.brandId;

/** Look up a registered brand profile; defaults to the active brand. */
export function getBrandProfile(brandId: string = ACTIVE_BRAND_ID): BrandProfile {
  return BRANDS[brandId] ?? MILVEXIAN_PROFILE;
}
