/**
 * Generates a real, branded, NON-PROMOTIONAL Milvexian detail-aid deck as .pptx.
 * Mirrors src/lib/milvexian-deck.ts (kept in sync by hand — this is a build tool).
 * Output: public/decks/milvexian.pptx  ·  run: node scripts/gen-milvexian-deck.mjs
 */
import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "decks");
mkdirSync(OUT_DIR, { recursive: true });

const NAVY = "0B2E63", INK = "12233B", RED = "C8102E", SLATE = "5B6B7F", MIST = "EAF0F7", PAPER = "FFFFFF";
const SPONSOR = "Johnson & Johnson · in collaboration with Bristol Myers Squibb";
const DISCLOSURE = "Investigational — not approved by the FDA or any regulatory authority. Non-promotional; for healthcare professionals.";

const pptx = new pptxgen();
pptx.author = "NexusRep";
pptx.company = "Johnson & Johnson";
pptx.subject = "Milvexian — investigational (non-promotional)";
pptx.title = "Milvexian Detail Aid";
pptx.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in (16:9)
const W = 13.333;

// Shared chrome: left navy rail + footer disclosure + "INVESTIGATIONAL" flag.
function chrome(slide, label) {
  slide.background = { color: PAPER };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.28, h: 7.5, fill: { color: NAVY } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.28, y: 0, w: 0.06, h: 7.5, fill: { color: RED } });
  slide.addText("MILVEXIAN", { x: 0.7, y: 0.32, w: 6, h: 0.3, fontFace: "Arial", fontSize: 11, bold: true, color: NAVY, charSpacing: 2 });
  slide.addText("INVESTIGATIONAL", { x: W - 3.2, y: 0.32, w: 2.5, h: 0.3, align: "right", fontFace: "Arial", fontSize: 10, bold: true, color: RED, charSpacing: 1 });
  if (label) slide.addText(label.toUpperCase(), { x: 0.7, y: 0.62, w: 6, h: 0.25, fontFace: "Arial", fontSize: 9, color: SLATE, charSpacing: 1 });
  slide.addText(DISCLOSURE, { x: 0.7, y: 7.02, w: W - 1.4, h: 0.35, fontFace: "Arial", fontSize: 8, italic: true, color: SLATE });
}

function contentSlide({ label, title, subtitle, bullets }) {
  const s = pptx.addSlide();
  chrome(s, label);
  s.addText(title, { x: 0.7, y: 1.15, w: W - 1.4, h: 0.8, fontFace: "Arial", fontSize: 30, bold: true, color: INK });
  if (subtitle) s.addText(subtitle, { x: 0.7, y: 1.95, w: W - 1.4, h: 0.5, fontFace: "Arial", fontSize: 16, color: RED });
  s.addText(
    bullets.map((t) => ({ text: t, options: { bullet: { code: "2022", indent: 18 }, paraSpaceAfter: 10 } })),
    { x: 0.8, y: 2.7, w: W - 1.8, h: 3.9, fontFace: "Arial", fontSize: 15, color: INK, lineSpacingMultiple: 1.15, valign: "top" },
  );
  return s;
}

// 1 — Title
{
  const s = pptx.addSlide();
  s.background = { color: NAVY };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.4, w: 4.2, h: 0.07, fill: { color: RED } });
  s.addText("Milvexian", { x: 0.9, y: 2.2, w: 11, h: 1.1, fontFace: "Arial", fontSize: 54, bold: true, color: PAPER });
  s.addText("Investigational Oral Factor XIa (FXIa) Inhibitor", { x: 0.9, y: 3.55, w: 11, h: 0.6, fontFace: "Arial", fontSize: 22, color: "AFC4E4" });
  s.addText(SPONSOR, { x: 0.9, y: 4.5, w: 11, h: 0.4, fontFace: "Arial", fontSize: 14, color: "AFC4E4" });
  s.addText("LIBREXIA Phase 3 Program · Cardiovascular", { x: 0.9, y: 4.95, w: 11, h: 0.4, fontFace: "Arial", fontSize: 14, bold: true, color: PAPER });
  s.addText("INVESTIGATIONAL · NON-PROMOTIONAL · FOR HEALTHCARE PROFESSIONALS", { x: 0.9, y: 6.4, w: 11, h: 0.4, fontFace: "Arial", fontSize: 10, color: "7FA0C8", charSpacing: 1 });
}

// 2–4 — Mechanism, Program, Status
contentSlide({
  label: "Mechanism", title: "Mechanism of action", subtitle: "Selective inhibition of Factor XIa",
  bullets: [
    "Milvexian is an investigational, orally administered small-molecule inhibitor of Factor XIa (FXIa).",
    "FXIa sits in the intrinsic (contact) coagulation pathway, upstream of thrombin generation.",
    "Scientific hypothesis under study: uncoupling pathological thrombosis from protective hemostasis.",
    "Mechanistic overview only — efficacy and safety have not been established.",
  ],
});
contentSlide({
  label: "LIBREXIA program", title: "The LIBREXIA Phase 3 program", subtitle: "Three cardiovascular indications under investigation",
  bullets: [
    "LIBREXIA-STROKE — secondary prevention of ischemic stroke.",
    "LIBREXIA-ACS — acute coronary syndrome.",
    "LIBREXIA-AF — atrial fibrillation.",
    "Large, ongoing global Phase 3 trials; publicly disclosed program information only.",
  ],
});
contentSlide({
  label: "Development status", title: "Development status", subtitle: "Investigational compound",
  bullets: [
    "Received U.S. FDA Fast Track designation for disclosed indications.",
    "Not approved by the FDA or any regulatory authority for any use.",
    "Safety and efficacy have not been established.",
    "Clinical specifics (dosing, titration, comparative data) are routed to Medical Information.",
  ],
});

// 5 — ISI (tinted panel)
{
  const s = pptx.addSlide();
  chrome(s, "Important Safety Information");
  s.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.15, w: W - 1.4, h: 5.6, fill: { color: MIST }, line: { color: "D3DEEC", width: 1 } });
  s.addText("Important Safety Information", { x: 1.0, y: 1.45, w: W - 2, h: 0.7, fontFace: "Arial", fontSize: 26, bold: true, color: INK });
  s.addText(
    [
      "Milvexian is an investigational compound not approved by the FDA or any regulatory authority; its safety and efficacy have not been established.",
      "This information is non-promotional and intended for healthcare professionals.",
      "Adverse events should be reported to Pharmacovigilance.",
      "Clinical questions can be directed to Medical Information.",
    ].map((t) => ({ text: t, options: { bullet: { code: "2022", indent: 18 }, paraSpaceAfter: 12 } })),
    { x: 1.1, y: 2.5, w: W - 2.4, h: 3.9, fontFace: "Arial", fontSize: 15, color: INK, lineSpacingMultiple: 1.15, valign: "top" },
  );
}

// 6 — Contact
contentSlide({
  label: "Medical Information", title: "Connect with a person", subtitle: "The AI rep routes anything clinical",
  bullets: [
    "Clinical / off-label questions → Medical Information & MSL.",
    "Suspected adverse events → Pharmacovigilance (safety desk).",
    "Request a human representative at any time.",
  ],
});

await pptx.writeFile({ fileName: join(OUT_DIR, "milvexian.pptx") });
console.log("wrote", join(OUT_DIR, "milvexian.pptx"));
