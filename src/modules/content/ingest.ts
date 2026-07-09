/**
 * Content ingestion + normalization (brief §21 Stages 3–4; PDF §5).
 *
 *   raw source (PPT/PDF/script/ISI/FAQ) → source adapter → parser/normalizer
 *     → canonical ContentAsset + ApprovedAnswer blocks (+ SafetyStatement for ISI)
 *     → MLR metadata attached → eligible for retrieval
 *
 * Raw source text NEVER directly controls a response — it is normalized into
 * canonical approved blocks first, each carrying MLR metadata. The parser here is
 * a deterministic mock (split into blocks, infer topic); a real PPT/PDF extractor
 * implements the same `parse` contract without changing downstream logic.
 */

import {
  asId,
  type ApprovedAnswerId,
  type BrandId,
  type CampaignId,
  type ContentAssetId,
  type DetailAidSlideId,
  type SafetyStatementId,
  type TenantId,
} from "@lib/ids";
import type {
  ApprovedAnswer,
  ContentAsset,
  DetailAidSlide,
  MlrMetadata,
  SafetyStatement,
} from "./types";
import { isPptx, parsePptx } from "./parsers/pptx";
import { isPdf, parsePdf } from "./parsers/pdf";

export interface RawSource {
  kind: ContentAsset["kind"];
  title: string;
  tenantId?: TenantId;
  brandId?: BrandId;
  campaignId?: CampaignId;
  /** Raw extracted text. Blocks separated by blank lines (mock parser contract). */
  text: string;
  mlr: MlrMetadata;
}

export interface IngestResult {
  asset: ContentAsset;
  answers: ApprovedAnswer[];
  slides: DetailAidSlide[];
  safety: SafetyStatement[];
}

// GENERIC clinical topic terms only. Brand vocabulary (trial names, target pathway…)
// arrives via `topicHints` from the BrandProfile lexicon — this engine file stays brand-free.
const TOPIC_TERMS: { topic: string; terms: RegExp }[] = [
  { topic: "mechanism", terms: /mechanism|mode of action|\bmoa\b|inhibitor|target/i },
  { topic: "program", terms: /program|phase\s*[123]|pipeline|under study|indications? under/i },
  // "approved" alone would match nearly every compliant sentence ("per the approved
  // guidance") — require the regulatory phrasing, not the bare word.
  { topic: "status", terms: /fda|fda[- ]approved|not approved|investigational|fast track|regulatory|designation/i },
  { topic: "indication", terms: /indication|atrial fibrillation|acute coronary|acs|ischemic stroke|secondary prevention/i },
  { topic: "dosing", terms: /dos|titrat|mg|once daily|maintenance/i },
  { topic: "safety", terms: /safety|bleed|contraindicat|warning|hypersensitiv|adverse|risk|isi|important safety/i },
  { topic: "trial_data", terms: /trial|endpoint|placebo|study|evidence|adherence/i },
  { topic: "administration", terms: /administer|inject|infus|route/i },
  { topic: "access", terms: /coverage|access|cost|prior auth|reimburs/i },
];

/** Brand topic hints (BrandProfile.lexicon.topicSynonyms): topic → words that mark it. */
export type TopicHints = Record<string, string[]>;

function inferTopic(text: string, hints?: TopicHints): string {
  // Brand hints win first — the brand knows its own vocabulary better than the generic list.
  const lower = text.toLowerCase();
  for (const [topic, words] of Object.entries(hints ?? {})) {
    if (words.some((w) => w && lower.includes(w.toLowerCase()))) return topic;
  }
  return TOPIC_TERMS.find((t) => t.terms.test(text))?.topic ?? "other";
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`))
    .join(" ");
}

function cleanHeading(s: string): string {
  return s
    .replace(/^[\s\-\u2022*#\d.)]+/, "")
    .replace(/[.!?;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferSlideTitle(text: string, fallbackTitle: string, index: number): string {
  const firstSentence = cleanHeading(text.split(/[.!?]\s+/)[0] ?? "");
  const short = firstSentence.length <= 72 ? firstSentence : "";
  if (short.length >= 8 && /[a-zA-Z]/.test(short)) return short;

  const topic = inferTopic(text);
  const topicTitle: Record<string, string> = {
    mechanism: "Mechanism of action",
    program: "Clinical program",
    status: "Development status",
    indication: "Indications under study",
    dosing: "Dosing information",
    safety: "Safety information",
    trial_data: "Clinical evidence",
    administration: "Administration",
    access: "Access information",
    other: "",
  };
  return topicTitle[topic] || `${fallbackTitle || "Uploaded content"} slide ${index + 1}`;
}

/**
 * Extract raw text from an uploaded document. Real PPTX extraction (one block
 * per slide, blank-line separated so the normalizer keeps slide boundaries);
 * plain text/markdown pass through. The result flows into `ingestSource`, which
 * attaches non-active MLR metadata — parsed content is NEVER live until approved.
 */
export async function extractSourceText(filename: string, bytes: Uint8Array): Promise<string> {
  if (isPptx(filename)) {
    const slides = await parsePptx(bytes);
    if (slides.length === 0) throw new Error("no slide text found in .pptx");
    return slides.join("\n\n");
  }
  if (isPdf(filename)) {
    const text = await parsePdf(bytes);
    // A scanned/image-only PDF has no extractable text — fail loudly so the user
    // knows to upload a text PDF rather than silently ingesting an empty document.
    if (!text.trim()) throw new Error("no text found in .pdf (is it a scanned/image-only file?)");
    return text;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    return new TextDecoder().decode(bytes);
  }
  throw new Error(`unsupported file type (supported: .pptx, .pdf, .txt, .md): ${filename}`);
}

/** Split raw text into approved blocks: paragraphs (blank-line separated). */
export function parseBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 0);
}

/**
 * Normalize a raw source into canonical objects. `idPrefix` keeps generated ids
 * deterministic for tests/seeding. ISI sources become verbatim SafetyStatements;
 * all other kinds become ApprovedAnswers with a detail-aid slide each.
 */
export function ingestSource(raw: RawSource, idPrefix: string, opts?: { topicHints?: TopicHints }): IngestResult {
  const assetId = asId<"content_asset_id">(`${idPrefix}_asset`) as ContentAssetId;
  const asset: ContentAsset = {
    id: assetId,
    tenantId: raw.tenantId ?? asId<"tenant_id">("tenant"),
    brandId: raw.brandId ?? asId<"brand_id">("brand"),
    campaignId: raw.campaignId ?? asId<"campaign_id">("campaign"),
    kind: raw.kind,
    title: raw.title,
    mlr: raw.mlr,
  };

  const blocks = parseBlocks(raw.text);
  const answers: ApprovedAnswer[] = [];
  const slides: DetailAidSlide[] = [];
  const safety: SafetyStatement[] = [];

  blocks.forEach((text, i) => {
    if (raw.kind === "isi") {
      safety.push({
        id: asId<"safety_statement_id">(`${idPrefix}_isi_${i}`) as SafetyStatementId,
        tenantId: asset.tenantId,
        brandId: asset.brandId,
        campaignId: asset.campaignId,
        text,
        mlr: raw.mlr,
      });
      return;
    }
    const slideId = asId<"detail_aid_slide_id">(`${idPrefix}_slide_${i}`) as DetailAidSlideId;
    const topic = inferTopic(text, opts?.topicHints);
    const slideTitle = inferSlideTitle(text, raw.title, i);
    slides.push({ id: slideId, contentAssetId: assetId, title: slideTitle, label: `${titleCase(topic.replace(/_/g, " "))} · Slide ${i + 1} / ${blocks.length}`, position: i + 1 });
    answers.push({
      id: asId<"approved_answer_id">(`${idPrefix}_ans_${i}`) as ApprovedAnswerId,
      tenantId: asset.tenantId,
      brandId: asset.brandId,
      campaignId: asset.campaignId,
      contentAssetId: assetId,
      topic,
      text,
      detailAidSlideId: slideId,
      mlr: raw.mlr,
    });
  });

  return { asset, answers, slides, safety };
}
