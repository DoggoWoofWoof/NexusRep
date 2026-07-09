/**
 * Demo data for the NexusRep brand console + HCP experience, ported faithfully
 * from the NexusRep.dc.html prototype. This is presentation/demo data for the UI
 * port; the real module logic (compliance, retrieval, CRM outbox, etc.) lives in
 * src/modules/* and is wired into the screens that drive live behavior.
 */

export type SegTone = "green" | "yellow" | "pink";

export interface Hcp {
  id: string;
  rank: number;
  name: string;
  specialty: string;
  institution: string;
  decile: string;
  segment: string;
  segTone: SegTone;
  patients: string;
  score: string;
  trend: string;
  up: boolean;
  topic: string;
  rationale: string[];
  affinity: { label: string; pct: number }[];
}

export const HCPS: Hcp[] = [
  { id: "sharma", rank: 1, name: "Dr. A. Sharma", specialty: "Interventional Cardiology", institution: "Mercy Heart Institute", decile: "D3", segment: "High Growth", segTone: "green", patients: "2,847", score: "92.1", trend: "+18%", up: true, topic: "Program overview",
    rationale: ["Top-quartile eligible-patient density for ACS in region (2,847).", "Prescribing whitespace: high anticoagulation volume, no exposure to the new mechanism.", "Growth trend +18% QoQ — accelerating ACS caseload."],
    affinity: [{ label: "Program", pct: 88 }, { label: "Investigational status", pct: 64 }, { label: "Mechanism of action", pct: 52 }] },
  { id: "okafor", rank: 2, name: "Dr. M. Okafor", specialty: "Interventional Cardiology", institution: "St. Vincent Cardiovascular", decile: "D2", segment: "ACS Whitespace", segTone: "yellow", patients: "3,102", score: "90.4", trend: "+12%", up: true, topic: "Mechanism of action",
    rationale: ["Highest eligible-patient density in cohort (3,102).", "Decile 2 anticoagulation writer with no familiarity with the new mechanism.", "Strong fit for interventional ACS awareness."],
    affinity: [{ label: "Program", pct: 79 }, { label: "Mechanism of action", pct: 71 }, { label: "Investigational status", pct: 58 }] },
  { id: "castellano", rank: 3, name: "Dr. L. Castellano", specialty: "Cardiology", institution: "Lakeshore Medical Group", decile: "D4", segment: "AFib Density", segTone: "pink", patients: "1,956", score: "87.9", trend: "+9%", up: true, topic: "Investigational status",
    rationale: ["High AFib eligible-patient density among existing panel.", "Responsive to trial-program and MoA content historically.", "Moderate density, steady +9% growth."],
    affinity: [{ label: "Investigational status", pct: 84 }, { label: "Program", pct: 62 }, { label: "Mechanism of action", pct: 49 }] },
  { id: "nguyen", rank: 4, name: "Dr. R. Nguyen", specialty: "Cardiac Electrophysiology", institution: "Summit Arrhythmia Center", decile: "D3", segment: "New Writer", segTone: "green", patients: "2,134", score: "85.3", trend: "+22%", up: true, topic: "Mechanism of action",
    rationale: ["Fastest-growing trend in cohort (+22%).", "High AFib volume — early-adopter profile.", "High receptivity to MoA and trial-program content."],
    affinity: [{ label: "Mechanism of action", pct: 77 }, { label: "Program", pct: 69 }, { label: "Investigational status", pct: 55 }] },
  { id: "andersson", rank: 5, name: "Dr. P. Andersson", specialty: "Cardiology", institution: "Northgate Physicians", decile: "D5", segment: "Re-engage", segTone: "yellow", patients: "1,420", score: "81.7", trend: "-3%", up: false, topic: "FDA Fast Track status",
    rationale: ["Declining trend (-3%) — at risk of lapse.", "Previously engaged; no touch in 90 days.", "Re-engagement opportunity with development-status update."],
    affinity: [{ label: "Investigational status", pct: 66 }, { label: "Program", pct: 51 }, { label: "Mechanism of action", pct: 44 }] },
  { id: "haddad", rank: 6, name: "Dr. S. Haddad", specialty: "Interventional Cardiology", institution: "Riverside Heart & Vascular", decile: "D2", segment: "ACS Whitespace", segTone: "yellow", patients: "2,560", score: "80.2", trend: "+6%", up: true, topic: "Mechanism of action",
    rationale: ["Decile 2 with clear ACS whitespace.", "Solid density (2,560), modest growth.", "Good candidate for mechanism-led awareness."],
    affinity: [{ label: "Mechanism of action", pct: 73 }, { label: "Program", pct: 60 }, { label: "Investigational status", pct: 48 }] },
  { id: "whitfield", rank: 7, name: "Dr. J. Whitfield", specialty: "Vascular Neurology", institution: "Parkview Stroke Center", decile: "D6", segment: "Low Touch", segTone: "pink", patients: "980", score: "74.5", trend: "+1%", up: true, topic: "Program overview",
    rationale: ["Lower density but under-served (low touch).", "Secondary-stroke-prevention caseload — efficient incremental reach.", "Flat trend — awareness-building candidate."],
    affinity: [{ label: "Program", pct: 54 }, { label: "Mechanism of action", pct: 47 }, { label: "Investigational status", pct: 39 }] },
  { id: "volkova", rank: 8, name: "Dr. E. Volkova", specialty: "Cardiology", institution: "Eastside Medical Partners", decile: "D4", segment: "AFib Density", segTone: "pink", patients: "1,610", score: "72.8", trend: "+4%", up: true, topic: "Investigational status",
    rationale: ["High AFib eligible-patient density (1,610).", "Receptive to trial-program resources.", "Steady +4% growth."],
    affinity: [{ label: "Investigational status", pct: 68 }, { label: "Program", pct: 57 }, { label: "Mechanism of action", pct: 43 }] },
];

export interface Turn {
  time: string;
  q: string;
  intent: string;
  source: string | null;
  sourceTitle: string | null;
  slide: string | null;
  isi: boolean;
  offLabel: boolean;
  response: string;
}

// TrainMode fallback transcript, shown ONLY if a live /api/conversation/turn call
// fails. Brand-agnostic placeholders — real turns come from the orchestrator.
export const CONVERSATION: Turn[] = [
  { time: "00:42", q: "What is this therapy and how does it work?", intent: "Public information · Mechanism", source: "DOC-0001", sourceTitle: "Product Fact Sheet — Mechanism", slide: "Slide 1 / 4", isi: false, offLabel: false,
    response: "Here's what I can share on that — I'm showing the mechanism overview now." },
  { time: "02:15", q: "This is an investigational compound, correct?", intent: "Public information · Development status", source: "DOC-0002", sourceTitle: "Investigational Disclosure Statement", slide: "Disclosure", isi: true, offLabel: false,
    response: "Correct — it is investigational and not FDA approved; its safety and efficacy have not been established. I'm delivering the full investigational disclosure for your review." },
  { time: "04:38", q: "What's the recommended dose and how does it compare?", intent: "Clinical detail · routed to Medical Info", source: null, sourceTitle: null, slide: null, isi: false, offLabel: false,
    response: "I'm not able to share dosing, efficacy, or comparative details for an investigational compound. I can route your request to Medical Information, who can follow up with you directly." },
  { time: "06:10", q: "Can I use it off-label for my patients?", intent: "Off-label request", source: null, sourceTitle: null, slide: null, isi: false, offLabel: true,
    response: "I'm not able to discuss off-label use — it's investigational and not approved for any use. I can connect you with a Medical Science Liaison who can help." },
];

export interface Rule {
  id: number;
  type: string;
  status: string;
  tier: string;
  text: string;
  note: string;
  scope: string;
  source: string;
  hcp?: string;
  from?: string;
}

// Seeded compliance guardrails (brand-agnostic — they apply to any pharma rep). The
// wording deliberately says "the product", never a specific brand, so a new brand needs
// no edits. Brand-specific coaching rules are added on top via the Train flow.
export const DEFAULT_RULES: Rule[] = [
  { id: 1, type: "Required talking point", status: "Active", tier: "Global", text: "State the investigational disclosure automatically whenever development status or approval is raised.", note: "", scope: "Compliance guardrail", source: "guardrail" },
  { id: 2, type: "Escalation rule", status: "Active", tier: "Global", text: "Route any dosing, efficacy, safety, or comparative question to Medical Information — never answer it directly.", note: "", scope: "Compliance guardrail", source: "guardrail" },
  { id: 3, type: "Style rule", status: "Active", tier: "Persona", text: "Open every session with the one-line AI disclosure before discussing the product.", note: "", scope: "AI Specialist", source: "guardrail" },
];

export interface SetupTopic {
  key: string;
  section: string;
  q: string;
  chips: [string, string][];
}

/**
 * The Setup Assistant's questions, driven by the active brand so a NEW brand needs no
 * edits: the product/indication/talking-point chips are filled from its BrandProfile
 * (falls back to generic labels while the brand loads or when none is set). The questions
 * themselves are brand-agnostic — the assistant is asking the user to confirm each field.
 */
export function setupTopicsFor(brand: { displayName: string; indication: string; talkingPoints: string[] } | null): SetupTopic[] {
  const product = brand?.displayName || "your product";
  const indication = brand?.indication || "the primary indication";
  const points = brand?.talkingPoints?.length ? brand.talkingPoints.join(", ") : "your key approved topics";
  return [
    { key: "brand", section: "profile", q: "First — which brand and product is this rep representing?", chips: [[product, product], ["Choose another…", "another brand"]] },
    { key: "indication", section: "profile", q: "Got it. Which indication is in scope for this rep?", chips: [[titleCase(indication), indication], ["Add another indication", "more indications"]] },
    { key: "persona", section: "profile", q: "Should the rep use a brand persona, or clone a real rep's likeness?", chips: [["Brand persona", "a brand persona"], ["Clone a rep (needs consent)", "a cloned rep persona"]] },
    { key: "voice", section: "profile", q: "What voice and style fits these HCPs best?", chips: [["Warm & concise", "a warm, concise voice"], ["Formal & precise", "a formal, precise voice"]] },
    { key: "audience", section: "audience", q: "Who should this rep prioritize? I can pull your whitespace cohort.", chips: [["Whitespace cohort", "the decile 2–4 whitespace cohort"], ["All targeted HCPs", "all targeted HCPs"]] },
    { key: "knowledge", section: "knowledge", q: "Use the approved public-information assets in your Vault as the rep's knowledge?", chips: [["Use all approved", "all approved assets"], ["Pick specific assets", "a selected set of assets"]] },
    { key: "escalation", section: "escalation", q: "Who handles medical escalations, and should a human rep be offered?", chips: [["Medical Info + human handoff", "the Medical Information desk with human handoff enabled"], ["Medical Info only", "the Medical Information desk only"]] },
    { key: "talking", section: "rules", q: "Which talking points matter most?", chips: [[titleCase(points), points], ["Let DocNexus prioritize", "DocNexus-prioritized talking points"]] },
    { key: "forbidden", section: "rules", q: "Anything the rep must avoid?", chips: [["Dosing, efficacy, comparative, off-label", "dosing, efficacy, comparative and off-label claims"], ["Standard guardrails only", "the standard guardrails"]] },
  ];
}

function titleCase(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// Fallback content library, shown only if the live content module returns nothing.
// Brand-agnostic placeholders — real assets come from MLR / content ingestion.
export const KNOWLEDGE_ASSETS = [
  { kind: "PDF", name: "Product Fact Sheet", mlrId: "DOC-0001", status: "Active" },
  { kind: "DOC", name: "Investigational Disclosure Statement", mlrId: "DOC-0002", status: "Active" },
  { kind: "PDF", name: "Program Overview", mlrId: "DOC-0003", status: "Active" },
  { kind: "DOC", name: "Development Status Disclosure", mlrId: "DOC-0004", status: "In MLR" },
];

// Overview / Command Center KPIs (representative, themed to the campaign).
export const COMMAND_KPIS = [
  { tone: "blue", label: "Sessions completed", value: "128", sub: "82% completion rate" },
  { tone: "fg", label: "Target HCPs", value: "37", sub: "Decile 2–4 whitespace" },
  { tone: "yellow", label: "Follow-ups pending", value: "14", sub: "Auto-created from sessions" },
  { tone: "green", label: "Disclosure delivery", value: "100%", sub: "Investigational disclosure given" },
  { tone: "yellow", label: "MLR / content issues", value: "1", sub: "Asset pending review" },
  { tone: "red", label: "CRM export issues", value: "2", sub: "Failed — awaiting retry" },
];

export const VENDOR_STACK = [
  { role: "Realtime / conversation", vendor: "GPT Realtime (adapter)" },
  { role: "Voice — TTS", vendor: "Browser / ElevenLabs (adapter)" },
  { role: "Voice — ASR", vendor: "Whisper (adapter)" },
  { role: "Avatar", vendor: "TalkingHead · Tavus (adapter)" },
  { role: "Retrieval", vendor: "pgvector (adapter)" },
];

export const CRM_CONNECTORS = ["Veeva Vault CRM", "Salesforce Life Sciences", "IQVIA OCE", "CSV / JSON export"];

export interface SessionRow {
  id: string;
  hcp: string;
  date: string;
  duration: string;
  questions: number;
  comp: string;
  compTone: SegTone | "red";
  followup: string;
}

export const SESSIONS: SessionRow[] = [
  { id: "SX-4471", hcp: "Dr. A. Sharma", date: "2026-06-19 09:42", duration: "07:48", questions: 4, comp: "Approved", compTone: "green", followup: "Medical Info follow-up" },
  { id: "SX-4468", hcp: "Dr. M. Okafor", date: "2026-06-18 14:05", duration: "12:10", questions: 6, comp: "Approved", compTone: "green", followup: "Rep follow-up" },
  { id: "SX-4465", hcp: "Dr. L. Castellano", date: "2026-06-18 11:20", duration: "06:30", questions: 3, comp: "Needs review", compTone: "yellow", followup: "Materials sent" },
  { id: "SX-4462", hcp: "Dr. R. Nguyen", date: "2026-06-17 16:48", duration: "05:32", questions: 3, comp: "AE routed", compTone: "pink", followup: "PV routing" },
  { id: "SX-4459", hcp: "Dr. P. Andersson", date: "2026-06-17 10:15", duration: "02:14", questions: 1, comp: "Blocked + escalated", compTone: "red", followup: "MSL follow-up" },
  { id: "SX-4455", hcp: "Dr. S. Haddad", date: "2026-06-16 13:30", duration: "09:05", questions: 5, comp: "Approved", compTone: "green", followup: "Rep follow-up" },
];

export interface CrmEventRow {
  id: number;
  hcp: string;
  reason: string;
  owner: string;
  target: string;
  status: string;
}

export const CRM_EVENTS: CrmEventRow[] = [
  { id: 0, hcp: "Dr. A. Sharma", reason: "Medical Information follow-up", owner: "J. Rivera", target: "Veeva", status: "Created" },
  { id: 1, hcp: "Dr. M. Okafor", reason: "MSL follow-up — clinical data request", owner: "L. Wong", target: "Veeva", status: "Sent to CRM" },
  { id: 2, hcp: "Dr. L. Castellano", reason: "Program materials", owner: "M. Johnson", target: "Salesforce", status: "Needs mapping" },
  { id: 3, hcp: "Dr. P. Andersson", reason: "Human rep callback — re-engage", owner: "A. Hassan", target: "Veeva", status: "Failed" },
  { id: 4, hcp: "Dr. R. Nguyen", reason: "Pharmacovigilance — AE capture", owner: "Safety desk", target: "IQVIA", status: "Sent to CRM" },
];

export const ANALYTICS_TABS = [
  { key: "targeting", label: "Targeting" },
  { key: "engagement", label: "Engagement" },
  { key: "content", label: "Content" },
  { key: "compliance", label: "Compliance" },
  { key: "ops", label: "CRM / Ops" },
  { key: "realtime", label: "Realtime quality" },
];

type Kpi = { tone: string; value: string; label: string; sub: string };
export const ANALYTICS_KPIS: Record<string, Kpi[]> = {
  targeting: [
    { tone: "blue", value: "37", label: "High-opportunity HCPs", sub: "Decile 2–4 whitespace" },
    { tone: "fg", value: "88.4", label: "Avg opportunity score", sub: "Density × whitespace × trend" },
    { tone: "fg", value: "64,210", label: "Eligible patients", sub: "Claims-derived, no PHI" },
    { tone: "green", value: "+14%", label: "Whitespace growth QoQ", sub: "Net new opportunity" },
  ],
  engagement: [
    { tone: "blue", value: "4,820", label: "Outreach sent", sub: "AI rep invitations" },
    { tone: "fg", value: "71%", label: "Invite open rate", sub: "Opened the secure invite" },
    { tone: "fg", value: "68%", label: "Session start rate", sub: "Began an AI detail" },
    { tone: "green", value: "82%", label: "Completion rate", sub: "Reached end of detail" },
  ],
  content: [
    { tone: "blue", value: "18", label: "Approved assets live", sub: "Usable by the AI rep" },
    { tone: "fg", value: "7", label: "Public-info assets in rotation", sub: "Most-used this campaign" },
    { tone: "green", value: "100%", label: "Answers source-grounded", sub: "Tied to an approved source" },
    { tone: "red", value: "3", label: "Content gaps", sub: "Topics lacking approved answer" },
  ],
  compliance: [
    { tone: "green", value: "100%", label: "Disclosure delivery rate", sub: "Investigational disclosure given" },
    { tone: "fg", value: "37", label: "Off-label refusals", sub: "Blocked, routed to MSL" },
    { tone: "fg", value: "12", label: "AE captures", sub: "Flagged to pharmacovigilance" },
    { tone: "red", value: "0", label: "Unapproved responses", sub: "Spoken without a source" },
  ],
  ops: [
    { tone: "green", value: "99.8%", label: "CRM export success", sub: "Delivered to connector" },
    { tone: "red", value: "2", label: "Failed exports", sub: "Awaiting retry" },
    { tone: "fg", value: "1,128", label: "Follow-ups sent", sub: "To CRM / field owners" },
    { tone: "fg", value: "64%", label: "Follow-up completion", sub: "Tasks acted on by field" },
  ],
  realtime: [
    { tone: "fg", value: "240ms", label: "Perceived latency", sub: "p50 response time" },
    { tone: "fg", value: "180ms", label: "Response start", sub: "Time to first word" },
    { tone: "green", value: "96%", label: "Interruption recovery", sub: "Barge-in handled cleanly" },
    { tone: "fg", value: "0.4%", label: "Fallback rate", sub: "Routed to text fallback" },
  ],
};

export const TONE_COLORS: Record<string, string> = {
  blue: "var(--dn-brand-base)",
  green: "var(--dn-success)",
  yellow: "var(--dn-warning)",
  red: "var(--dn-danger)",
  fg: "var(--dn-fg)",
};

export function segStyle(tone: SegTone): React.CSSProperties {
  const m: Record<SegTone, [string, string]> = {
    green: ["var(--dn-accent-green-bg)", "#166534"],
    yellow: ["var(--dn-accent-yellow-bg)", "#92400e"],
    pink: ["var(--dn-accent-pink-bg)", "#9d174d"],
  };
  const [bg, color] = m[tone] ?? m.green;
  return { display: "inline-block", padding: "4px 9px", borderRadius: 20, font: "600 10.5px/1 var(--dn-font-sans)", background: bg, color };
}

export function compStyle(tone: SegTone | "red"): React.CSSProperties {
  if (tone === "red") return { display: "inline-block", padding: "4px 9px", borderRadius: 20, font: "600 10.5px/1 var(--dn-font-sans)", background: "#fee2e2", color: "#991b1b" };
  return segStyle(tone);
}
