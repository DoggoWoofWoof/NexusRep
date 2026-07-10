/**
 * Approved-content domain (brief §16, §17; PDF §5). Content is the ONLY thing
 * the HCP-facing rep may speak. Every approved object carries MLR metadata,
 * version, audience, indication, market, campaign, status, and expiry so the
 * source validator can decide eligibility deterministically.
 */

import type {
  ApprovedAnswerId,
  BrandId,
  CampaignId,
  ContentAssetId,
  DetailAidSlideId,
  MlrApprovalId,
  SafetyStatementId,
  TenantId,
} from "@lib/ids";

/** Approval state machine. Only ACTIVE content may be retrieved for live responses. */
export type ContentStatus = "draft" | "in_mlr" | "active" | "expired" | "retired";

export interface MlrMetadata {
  mlrApprovalId: MlrApprovalId;
  status: ContentStatus;
  version: number;
  audience: string; // e.g. "cardiologist"
  indication: string; // e.g. "ACS"
  market: string; // e.g. "US"
  /** ISO date string; null = no expiry. */
  expiresAt: string | null;
  sourceFile: string; // original PPT/PDF/script filename
}

export interface ContentAsset {
  id: ContentAssetId;
  tenantId: TenantId;
  brandId: BrandId;
  campaignId: CampaignId;
  kind: "ppt" | "pdf" | "script" | "faq" | "isi";
  title: string;
  mlr: MlrMetadata;
}

/** A retrievable, speakable approved answer block. */
export interface ApprovedAnswer {
  id: ApprovedAnswerId;
  tenantId: TenantId;
  brandId: BrandId;
  campaignId: CampaignId;
  contentAssetId: ContentAssetId;
  topic: string; // dosing | safety | administration | trial_data | access …
  /** Verbatim approved text. The response builder composes from these — never invents. */
  text: string;
  /** Optional detail-aid slide to display alongside. */
  detailAidSlideId?: DetailAidSlideId;
  /** Set on a proposed REVISION: the currently-active answer this draft replaces.
   *  MLR approval of the revision retires the superseded version atomically. */
  supersedes?: ApprovedAnswerId;
  mlr: MlrMetadata;
}

/** A detail-aid slide the rep can display alongside an approved answer. */
export interface DetailAidSlide {
  id: DetailAidSlideId;
  contentAssetId: ContentAssetId;
  title: string;
  /** Human-facing label e.g. "Slide 4 / 12" or "ISI". */
  label: string;
  /** Source order inside the deck/PDF, used by the first-party presentation skill. */
  position?: number;
}

/** Verbatim safety statement (ISI). The final gate requires this exact text when ISI is due. */
export interface SafetyStatement {
  id: SafetyStatementId;
  tenantId: TenantId;
  brandId: BrandId;
  campaignId: CampaignId;
  text: string;
  mlr: MlrMetadata;
}

export function isRetrievable(mlr: MlrMetadata, now: Date = new Date()): boolean {
  if (mlr.status !== "active") return false;
  if (mlr.expiresAt && new Date(mlr.expiresAt).getTime() < now.getTime()) return false;
  return true;
}
