/**
 * Content & source-validation service. Holds the approved-content store and the
 * deterministic source validator the compliance flow depends on (PDF §6).
 *
 * Source validation is deliberately NOT an LLM call — MLR status, expiry,
 * audience, indication, market, campaign, and version are checked deterministically.
 */

import { MemoryRepositoryFactory, type Repository, type RepositoryFactory } from "@lib/repository";
import { err, ok, type Result } from "@lib/result";
import { asId, newId, type ApprovedAnswerId, type ContentAssetId, type DetailAidSlideId, type SafetyStatementId } from "@lib/ids";
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

  /**
   * Remove an uploaded source document and everything parsed from it (answers + slides).
   * FAIL-SAFE: refuses when any of its passages is ACTIVE — live rep knowledge can only be
   * retired through MLR (reject), never silently deleted out from under the compliance gate.
   * Returns what was removed, or an error string.
   */
  async removeAsset(id: ContentAssetId): Promise<{ removed: { answers: number; slides: number } } | { error: string }> {
    const asset = await this.assets.get(id);
    if (!asset) return { error: "asset not found" };
    const answers = (await this.answers.list()).filter((a) => a.contentAssetId === id);
    if (answers.some((a) => a.mlr.status === "active")) {
      return { error: "asset has ACTIVE approved passages — reject them in MLR review first" };
    }
    const slides = (await this.slides.list()).filter((sl) => sl.contentAssetId === id);
    for (const a of answers) await this.answers.delete(String(a.id));
    for (const sl of slides) await this.slides.delete(String(sl.id));
    await this.assets.delete(String(id));
    return { removed: { answers: answers.length, slides: slides.length } };
  }

  async addAnswer(answer: ApprovedAnswer): Promise<ApprovedAnswer> {
    return this.answers.insert(answer);
  }

  /**
   * Propose a REVISION of an approved passage: a new draft version (in MLR review) that
   * keeps the original's slide/topic/clinical scope. The current text stays live until a
   * reviewer approves the revision — nothing changes on the rep until MLR signs off.
   */
  async reviseAnswer(id: ApprovedAnswerId, text: string): Promise<ApprovedAnswer | { error: string }> {
    const original = await this.answers.get(String(id));
    if (!original) return { error: "answer not found" };
    if (original.mlr.status !== "active") return { error: "only ACTIVE approved passages can be revised" };
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return { error: "revision text is empty" };
    if (trimmed === original.text.replace(/\s+/g, " ").trim()) return { error: "revision is identical to the current approved text" };
    const revision: ApprovedAnswer = {
      ...original,
      id: newId<"approved_answer_id">("ans_rev"),
      text: trimmed.slice(0, 4000),
      supersedes: original.id,
      mlr: {
        ...original.mlr,
        mlrApprovalId: asId<"mlr_approval_id">("mlr_pending"),
        status: "in_mlr",
        version: original.mlr.version + 1,
        sourceFile: original.mlr.sourceFile,
      },
    };
    return this.answers.insert(revision);
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
