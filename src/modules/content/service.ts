/**
 * Content & source-validation service. Holds the approved-content store and the
 * deterministic source validator the compliance flow depends on (PDF §6).
 *
 * Source validation is deliberately NOT an LLM call — MLR status, expiry,
 * audience, indication, market, campaign, and version are checked deterministically.
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { err, ok, type Result } from "@lib/result";
import type { ApprovedAnswerId, ContentAssetId, DetailAidSlideId, SafetyStatementId } from "@lib/ids";
import { type ApprovedAnswer, type ContentAsset, type ContentStatus, type DetailAidSlide, type SafetyStatement, isRetrievable } from "./types";

export interface SourceValidationContext {
  audience?: string;
  indication?: string;
  market?: string;
  campaignId?: string;
  now?: Date;
}

export type SourceValidationError =
  | "not_found"
  | "not_active"
  | "expired"
  | "audience_mismatch"
  | "indication_mismatch"
  | "market_mismatch"
  | "campaign_mismatch";

export class ContentService {
  private readonly assets: Repository<ContentAsset>;
  private readonly answers: Repository<ApprovedAnswer>;
  private readonly safety: Repository<SafetyStatement>;
  private readonly slides: Repository<DetailAidSlide>;

  constructor(repos: RepositoryFactory = new MemoryRepositoryFactory()) {
    this.assets = repos.create<ContentAsset>("content_assets");
    this.answers = repos.create<ApprovedAnswer>("content_answers");
    this.safety = repos.create<SafetyStatement>("content_safety");
    this.slides = repos.create<DetailAidSlide>("content_slides");
  }

  async addAsset(asset: ContentAsset): Promise<ContentAsset> {
    return this.assets.insert(asset);
  }

  async getAsset(id: ContentAssetId): Promise<ContentAsset | null> {
    return this.assets.get(id);
  }

  async listAssets(): Promise<ContentAsset[]> {
    return this.assets.list();
  }

  async addAnswer(answer: ApprovedAnswer): Promise<ApprovedAnswer> {
    return this.answers.insert(answer);
  }

  async addSafetyStatement(stmt: SafetyStatement): Promise<SafetyStatement> {
    return this.safety.insert(stmt);
  }

  async getSafetyStatement(id: SafetyStatementId): Promise<SafetyStatement | null> {
    return this.safety.get(id);
  }

  async addSlide(slide: DetailAidSlide): Promise<DetailAidSlide> {
    return this.slides.insert(slide);
  }

  async getSlide(id: DetailAidSlideId): Promise<DetailAidSlide | null> {
    return this.slides.get(id);
  }

  async listSlides(): Promise<DetailAidSlide[]> {
    return this.slides.list();
  }

  async getAnswer(id: ApprovedAnswerId): Promise<ApprovedAnswer | null> {
    return this.answers.get(id);
  }

  async listAnswers(): Promise<ApprovedAnswer[]> {
    return this.answers.list();
  }

  /** Transition an answer's MLR status (draft → in_mlr → active | retired). */
  async setAnswerStatus(id: ApprovedAnswerId, status: ContentStatus): Promise<ApprovedAnswer | null> {
    const a = await this.answers.get(id);
    if (!a) return null;
    return this.answers.update(id, { mlr: { ...a.mlr, status } });
  }

  async listSafetyStatements(): Promise<SafetyStatement[]> {
    return this.safety.list();
  }

  /** Transition a safety statement's MLR status. */
  async setSafetyStatus(id: SafetyStatementId, status: ContentStatus): Promise<SafetyStatement | null> {
    const s = await this.safety.get(id);
    if (!s) return null;
    return this.safety.update(id, { mlr: { ...s.mlr, status } });
  }

  /**
   * Keep only one active ISI block per campaign. New wording is allowed, but it
   * becomes runtime-eligible only after approval; then the previous active block
   * is retired instead of competing with it.
   */
  async retireOtherActiveSafetyStatements(currentId: SafetyStatementId): Promise<void> {
    const current = await this.safety.get(currentId);
    if (!current) return;
    const all = await this.safety.list();
    await Promise.all(
      all
        .filter(
          (s) =>
            s.id !== currentId &&
            s.mlr.status === "active" &&
            s.tenantId === current.tenantId &&
            s.brandId === current.brandId &&
            s.campaignId === current.campaignId,
        )
        .map((s) => this.setSafetyStatus(s.id, "retired")),
    );
  }

  /** The exact active ISI block the runtime should append, preferring the newest version. */
  async latestActiveSafetyStatement(now: Date = new Date()): Promise<SafetyStatement | undefined> {
    const active = (await this.safety.list()).filter((s) => isRetrievable(s.mlr, now));
    return active.sort((a, b) => a.mlr.version - b.mlr.version).at(-1);
  }

  /**
   * Resolve a candidate answer id back to a canonical record and validate it is
   * eligible to speak. Returns the answer or a specific validation error.
   */
  async validateAnswer(
    id: ApprovedAnswerId,
    ctx: SourceValidationContext = {},
  ): Promise<Result<ApprovedAnswer, SourceValidationError>> {
    const answer = await this.answers.get(id);
    if (!answer) return err("not_found");

    const { mlr } = answer;
    if (mlr.status !== "active") return err("not_active");
    if (!isRetrievable(mlr, ctx.now)) return err("expired");
    if (ctx.audience && mlr.audience !== ctx.audience) return err("audience_mismatch");
    if (ctx.indication && mlr.indication !== ctx.indication) return err("indication_mismatch");
    if (ctx.market && mlr.market !== ctx.market) return err("market_mismatch");
    if (ctx.campaignId && answer.campaignId !== ctx.campaignId) return err("campaign_mismatch");

    return ok(answer);
  }
}
