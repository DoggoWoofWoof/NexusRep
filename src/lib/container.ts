/**
 * Composition root. Wires modules into a single app container and seeds a demo
 * tenant (Milvexian / cardiology) so the app + tests run with realistic data on
 * in-memory stores. This is the ONLY place concrete services are constructed;
 * API routes and pages receive ready-made services, never build their own.
 *
 * Swapping memory→Postgres or mock→real vendors happens here + in env.ts, with
 * no change to module logic (brief §14–15).
 */

import { asId, type AiRepId, type BrandId, type CampaignId, type ContentAssetId, type DetailAidSlideId, type HcpId, type MlrApprovalId, type SessionId, type TenantId } from "@lib/ids";
import { InMemoryVectorIndex } from "@lib/vector-index";
import { getRepositoryFactory } from "@lib/db";
import { ContentService, PresentationSkill, resolveComposer, type ApprovedAnswer, type ContentAsset, type MlrMetadata, type SafetyStatement } from "@modules/content";
import { resolveClassifier } from "@modules/compliance";
import { env } from "@lib/env";
import { RetrievalService } from "@modules/retrieval";
import { AuditService } from "@modules/audit";
import { FollowUpService } from "@modules/followups";
import { CrmOutbox } from "@modules/crm";
import { getCrmAdapter, getRetrievalProvider } from "@modules/vendors";
import { TurnOrchestrator, ConversationService } from "@modules/realtime";
import { SessionService } from "@modules/sessions";
import { TargetingService, loadCohort } from "@modules/audience";
import { AnalyticsService, RuntimeMetrics } from "@modules/analytics";
import { StudioService } from "@modules/aiRepStudio";
import { activeSteering } from "@modules/rules";
import { MlrService } from "@modules/mlr";
import { getBrandProfile, type BrandProfile } from "@modules/brand";
import { seedDemoHistory, seedDemoStudio } from "@lib/demo-seed";

export interface AppContainer {
  content: ContentService;
  presentation: PresentationSkill;
  retrieval: RetrievalService;
  audit: AuditService;
  followups: FollowUpService;
  crm: CrmOutbox;
  orchestrator: TurnOrchestrator;
  sessions: SessionService;
  conversation: ConversationService;
  targeting: TargetingService;
  analytics: AnalyticsService;
  metrics: RuntimeMetrics;
  studio: StudioService;
  mlr: MlrService;
  /** The active brand profile — the single source of brand/campaign-specific config. */
  brand: BrandProfile;
  demo: {
    tenantId: TenantId;
    brandId: BrandId;
    campaignId: CampaignId;
    aiRepId: AiRepId;
    hcpId: HcpId;
    sessionId: SessionId;
    audience: string;
    indication: string;
    market: string;
    /** Where the targeting cohort came from (DocNexus vs modeled fallback). */
    audienceSource: string;
    /** Milvexian is investigational → clinical specifics route to MSL. */
    investigational: boolean;
  };
}

// All brand/campaign-specific values come from the active BrandProfile — nothing
// Milvexian is hardcoded in the container. A new brand = a new profile (see @modules/brand).
const brand = getBrandProfile();
const tenantId = asId<"tenant_id">(brand.tenantId) as TenantId;
const brandId = asId<"brand_id">(brand.brandId) as BrandId;
const campaignId = asId<"campaign_id">(brand.campaignId) as CampaignId;
const aiRepId = asId<"ai_rep_id">(brand.aiRepId) as AiRepId;
const hcpId = asId<"hcp_id">("hcp_sharma") as HcpId;
const sessionId = asId<"session_id">("session_demo") as SessionId;
const audience = brand.clinical.audience;
const indication = brand.clinical.indication;
const market = brand.clinical.market;

function activeMlr(seed: string): MlrMetadata {
  return {
    mlrApprovalId: asId<"mlr_approval_id">(`mlr_${seed}`) as MlrApprovalId,
    status: "active",
    version: 1,
    audience,
    indication,
    market,
    expiresAt: "2027-01-01",
    sourceFile: `${brand.displayName}_MedicalInfo_v1.pptx`,
  };
}

/** Build a fully-wired, demo-seeded container. Synchronous wiring; async seeding. */
export async function createContainer(opts?: { seedHistory?: boolean }): Promise<AppContainer> {
  // Canonical persistence: in-memory (default) or embedded Postgres (PGlite) when
  // NEXUSREP_DATA_DRIVER=postgres. Persist across restarts by setting PGLITE_DATA_DIR;
  // default it to a local data dir so the postgres demo is durable out of the box.
  if (env.dataDriver === "postgres" && !process.env.PGLITE_DATA_DIR) {
    process.env.PGLITE_DATA_DIR = ".nexusrep-data";
  }
  const repos = getRepositoryFactory();
  const index = new InMemoryVectorIndex();
  const content = new ContentService(repos);
  const presentation = new PresentationSkill(content);
  const retrieval = new RetrievalService(getRetrievalProvider(index), content);
  const audit = new AuditService(repos);
  const followups = new FollowUpService(repos);
  const crm = new CrmOutbox(getCrmAdapter(), repos);
  // Default answer composition is deterministic (verbatim approved blocks) — the
  // compliance-safe default. Set NEXUSREP_COMPOSE=llm to let a grounded composer
  // rephrase (still grounding-validated + gated).
  const defaultComposer = env.composeMode === "llm" ? resolveComposer(env.classifierProvider) : null;
  const orchestrator = new TurnOrchestrator(content, retrieval, audit, followups, resolveClassifier(), defaultComposer);
  const sessions = new SessionService(repos);
  const studio = new StudioService(repos);
  // Coaching → behavior: each turn folds the rep's ACTIVE, compliance-cleared rules into
  // runtime steering (blocked topics reroute; lead topics re-rank). Draft/gated rules never
  // steer, so the compliance gate stays authoritative.
  const conversation = new ConversationService({
    orchestrator, sessions, crm, audit,
    context: { brandId, campaignId },
    steeringFor: async (hcpId) => activeSteering((await studio.get(aiRepId))?.rules ?? [], { hcpId }),
  });
  // Load the targeting cohort from the DocNexus claims backend when configured;
  // otherwise the modeled cardiology cohort. Never throws — falls back safely.
  const { cohort, source: audienceSource } = await loadCohort();
  // Score density relative to the cohort's top provider. For a pre-launch drug the
  // absolute claims counts for the target indications are small, so an absolute
  // reference makes every HCP flat-line at the whitespace baseline; ranking within
  // the cohort surfaces the real "who has the most eligible patients" ordering.
  const maxDensity = cohort.reduce((m, f) => Math.max(m, f.eligiblePatients), 0);
  const targeting = new TargetingService(cohort, {
    recommendedTopics: brand.recommendedTopics,
    indicationLabel: brand.clinical.indication,
    densityRef: maxDensity > 0 ? maxDensity : undefined,
  });
  const metrics = new RuntimeMetrics();
  const analytics = new AnalyticsService({ sessions, followups, crm, content, targeting, metrics });
  // MLR review loop: on approval, publish the answer to retrieval so the rep can
  // cite it. Nothing parsed/ingested is retrievable until it clears this gate.
  const mlr = new MlrService(content, async (a) => {
    await index.upsert({ refId: a.id, metadata: { audience: a.mlr.audience, indication: a.mlr.indication, market: a.mlr.market }, text: `${a.topic} ${a.text}` });
  });

  const assetId = asId<"content_asset_id">("asset_detail_aid") as ContentAssetId;
  const asset: ContentAsset = {
    id: assetId,
    tenantId,
    brandId,
    campaignId,
    kind: "ppt",
    title: `${brand.displayName} approved detail aid`,
    mlr: activeMlr("detail_aid"),
  };
  await content.addAsset(asset);

  for (const [i, s] of brand.deck.entries()) {
    await content.addSlide({
      id: asId<"detail_aid_slide_id">(s.id) as DetailAidSlideId,
      contentAssetId: assetId,
      title: s.title,
      label: s.label,
      position: i + 1,
    });
  }

  // Approved content is seeded from the active brand profile (demo). In production
  // these blocks come from content ingestion → MLR sign-off, not from source.
  // Investigational compounds seed only publicly-disclosed, non-promotional facts;
  // clinical specifics route to Medical Information via the investigational guardrail.
  for (const a of brand.approvedAnswers) {
    const slideId = asId<"detail_aid_slide_id">(a.detailAidSlideId) as DetailAidSlideId;
    const answer: ApprovedAnswer = {
      id: asId<"approved_answer_id">(a.id) as ApprovedAnswer["id"],
      tenantId,
      brandId,
      campaignId,
      contentAssetId: assetId,
      topic: a.topic,
      text: a.text,
      detailAidSlideId: slideId,
      mlr: activeMlr(a.id),
    };
    await content.addAnswer(answer);
    await index.upsert({
      refId: a.id,
      metadata: { audience, indication, market },
      text: `${a.topic} ${a.text}`,
    });
  }

  const isi: SafetyStatement = {
    id: asId<"safety_statement_id">("isi_main") as SafetyStatement["id"],
    tenantId,
    brandId,
    campaignId,
    text: brand.isiText,
    mlr: activeMlr("isi"),
  };
  await content.addSafetyStatement(isi);

  // Fake past sessions/follow-ups only when explicitly demoing (NEXUSREP_SEED_HISTORY=1
  // or an explicit createContainer({ seedHistory:true }) — used by tests). Off by
  // default so Sessions / Analytics / Follow-ups show ONLY real conversations.
  if (env.seedHistory || opts?.seedHistory) {
    await seedDemoHistory({ sessions, followups, crm, aiRepId, brandId, campaignId });
  }
  // The rep itself (persona, guardrails, approved-content sign-off) is always seeded
  // so the Studio is launch-ready and the rep can actually answer — not fake activity.
  await seedDemoStudio({ studio, aiRepId, brandId, campaignId, brand });

  return {
    content,
    presentation,
    retrieval,
    audit,
    followups,
    crm,
    orchestrator,
    sessions,
    conversation,
    targeting,
    analytics,
    metrics,
    studio,
    mlr,
    brand,
    demo: { tenantId, brandId, campaignId, aiRepId, hcpId, sessionId, audience, indication, market, audienceSource, investigational: brand.clinical.investigational },
  };
}

type ContainerGlobal = typeof globalThis & {
  __nexusrepContainerPromise?: Promise<AppContainer> | null;
};

const containerGlobal = globalThis as ContainerGlobal;

/** Lazily-built singleton for the running app (tests build their own fresh containers). */
export function getContainer(): Promise<AppContainer> {
  if (!containerGlobal.__nexusrepContainerPromise) {
    containerGlobal.__nexusrepContainerPromise = createContainer().catch((error) => {
      containerGlobal.__nexusrepContainerPromise = null;
      throw error;
    });
  }
  return containerGlobal.__nexusrepContainerPromise;
}
