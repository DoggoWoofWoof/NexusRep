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
import { getRepositoryFactory, makeRepositoryFactory } from "@lib/db";
import type { RepositoryFactory } from "@lib/repository";
import { appAuthEnabled, usernameFromCookie, userData, SESSION_COOKIE } from "@lib/auth-session";
import { ContentService, PresentationSkill, defaultComposer, type ApprovedAnswer, type ContentAsset, type MlrMetadata, type SafetyStatement } from "@modules/content";
import { configureClassifierLexicon, resolveClassifier } from "@modules/compliance";
import { env } from "@lib/env";
import { configureRetrievalLexicon, RetrievalService } from "@modules/retrieval";
import { AuditService } from "@modules/audit";
import { FollowUpService } from "@modules/followups";
import { CrmOutbox } from "@modules/crm";
import { getCrmAdapter, getRetrievalProvider } from "@modules/vendors";
import { TurnOrchestrator, ConversationService } from "@modules/realtime";
import { SessionService } from "@modules/sessions";
import { TargetingService, loadCohort, audienceQueryFor } from "@modules/audience";
import { AnalyticsService, RuntimeMetrics } from "@modules/analytics";
import { StudioService, toneDirective } from "@modules/aiRepStudio";
import { activeSteering } from "@modules/rules";
import { MlrService } from "@modules/mlr";
import { getBrandProfile, setupAnswersOf, type BrandProfile, resolveBrandProfile, BLANK_PROFILE } from "@modules/brand";
import { seedDemoHistory, seedDemoStudio, seedDraftStudio } from "@lib/demo-seed";

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
  /** Live audience-source state: current source, degraded flag, throttled re-fetch. */
  audienceRuntime: { readonly source: string; readonly degraded: boolean; refresh(): Promise<boolean>; reloadForBrandChange(): Promise<void> };
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

// The default (auth-off) brand. Its lexicon primes the generic engine layers once at load —
// onboarding a new brand supplies vocabulary via its profile, never engine edits. Per-user
// containers may pass their OWN brand (e.g. a blank profile for "clean" accounts).
const baseBrand = getBrandProfile();
configureClassifierLexicon([...baseBrand.lexicon.productTerms, ...baseBrand.persona.hotwords]);
configureRetrievalLexicon(baseBrand.lexicon.topicSynonyms);

/** Build a fully-wired, demo-seeded container. Synchronous wiring; async seeding. */
export async function createContainer(opts?: { seedHistory?: boolean; seedContent?: boolean; seedStudio?: "full" | "draft"; repos?: RepositoryFactory; brand?: BrandProfile }): Promise<AppContainer> {
  // Brand + its derived ids/context — per container, so a "clean" account can build from a BLANK
  // profile instead of inheriting Milvexian's deck / cohort / persona.
  const brand = opts?.brand ?? baseBrand;
  const tenantId = asId<"tenant_id">(brand.tenantId) as TenantId;
  const brandId = asId<"brand_id">(brand.brandId) as BrandId;
  const campaignId = asId<"campaign_id">(brand.campaignId) as CampaignId;
  const aiRepId = asId<"ai_rep_id">(brand.aiRepId) as AiRepId;
  const hcpId = asId<"hcp_id">(env.demoHcpId) as HcpId;
  const sessionId = asId<"session_id">("session_demo") as SessionId;
  const audience = brand.clinical.audience;
  const indication = brand.clinical.indication;
  const market = brand.clinical.market;
  const mlrExpiry = env.mlrExpiresAt || new Date(Date.now() + 548 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const activeMlr = (seed: string): MlrMetadata => ({
    mlrApprovalId: asId<"mlr_approval_id">(`mlr_${seed}`) as MlrApprovalId,
    status: "active",
    version: 1,
    audience,
    indication,
    market,
    expiresAt: mlrExpiry,
    sourceFile: `${brand.displayName}_MedicalInfo_v1.pptx`,
  });

  // Canonical persistence: in-memory (default), managed Postgres (node-pg) when DATABASE_URL is set,
  // or embedded Postgres (PGlite) when NEXUSREP_DATA_DRIVER=postgres. For the PGlite path, default
  // PGLITE_DATA_DIR to a local data dir so it's durable out of the box — but NOT when DATABASE_URL is
  // set (node-pg needs no local dir and would otherwise spin up an unused PGlite too).
  if (env.dataDriver === "postgres" && !env.databaseUrl && !process.env.PGLITE_DATA_DIR) {
    process.env.PGLITE_DATA_DIR = ".nexusrep-data";
  }
  // Tests inject a shared factory to prove restart semantics (seed-if-absent).
  const repos = opts?.repos ?? getRepositoryFactory();
  // Per-user containers vary WHAT is seeded: "demo" users clone the full demo (content + rep +
  // history); "clean" users get only a bare draft rep. Defaults preserve single-tenant behavior.
  const seedContent = opts?.seedContent ?? true;
  const seedStudioMode = opts?.seedStudio ?? "full";
  const seedHistory = opts?.seedHistory ?? env.seedHistory;
  const index = new InMemoryVectorIndex();
  const content = new ContentService(repos);
  // One composer choice shared by the live turn path AND the slide walkthrough, so both
  // LLM-compose from the KB when a provider key is present (env.composeMode auto-selects "llm"),
  // and both speak verbatim when not. null → deterministic.
  const composer = defaultComposer();
  const presentation = new PresentationSkill(content, composer);
  const retrieval = new RetrievalService(getRetrievalProvider(index), content);
  const audit = new AuditService(repos);
  const studio = new StudioService(repos);
  // Setup answers drive follow-up OWNERSHIP: the MSL / pharmacovigilance contacts the brand
  // user configured (by chat or in the escalation section) own the created tasks — the
  // generic labels are only the fallback when nothing is configured.
  const followups = new FollowUpService(repos, async (type) => {
    const answers = setupAnswersOf((await studio.get(aiRepId))?.draft);
    if (type === "pharmacovigilance") return answers["ae_routing"];
    if (type === "msl" || type === "medical_information") {
      return answers["msl_contact"]?.replace(/ · (human handoff enabled|no human handoff)$/, "");
    }
    return undefined;
  });
  const crm = new CrmOutbox(getCrmAdapter(), repos);
  // Answer composition: `composer` (resolved above) is the grounded LLM composer when a provider
  // key is present, else null → the deterministic verbatim builder. Same choice as the slide deck.
  const orchestrator = new TurnOrchestrator(content, retrieval, audit, followups, resolveClassifier(), composer);
  const sessions = new SessionService(repos);
  // Load the targeting cohort from the DocNexus claims backend when configured;
  // otherwise the modeled cardiology cohort. Never throws — falls back safely.
  // Targeting follows the RESOLVED brand (base profile + Setup Assistant answers), so
  // specialties/diagnosis codes edited by chatting actually drive the cohort query.
  const resolvedClinical = async () => {
    try {
      const draft = (await studio.get(aiRepId))?.draft;
      return resolveBrandProfile(brand, setupAnswersOf(draft)).clinical;
    } catch {
      return brand.clinical;
    }
  };
  // A brand with no declared targeting (e.g. a "clean" account's blank profile) gets an EMPTY
  // cohort — no Milvexian fallback — until the user configures specialties/diagnoses.
  const clinical0 = await resolvedClinical();
  const hasTargeting = Boolean(clinical0.specialties?.length || clinical0.diagnosisCodes?.length);
  const { cohort, source: audienceSource } = hasTargeting
    ? await loadCohort(audienceQueryFor(clinical0))
    : { cohort: [], source: "unconfigured" };
  // Coaching → behavior: each turn folds the rep's ACTIVE, compliance-cleared rules into
  // runtime steering (blocked topics reroute; lead topics re-rank). Draft/gated rules never
  // steer, so the compliance gate stays authoritative.
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
  const conversation = new ConversationService({
    orchestrator, sessions, crm, audit,
    context: { brandId, campaignId },
    steeringFor: async (hcpId) => {
      const snap = await studio.get(aiRepId);
      const steering = activeSteering(snap?.rules ?? [], { hcpId });
      // The persona's chosen tone becomes a style directive the composer honors (phrasing only,
      // under the grounding rules) — so "professional / warm / clinical" actually changes wording.
      const tone = toneDirective(snap?.rep.persona.voiceStyle);
      return tone ? { ...steering, styleGuidance: [...(steering.styleGuidance ?? []), tone] } : steering;
    },
    // CRM identity via the targeting service (prefix-tolerant, and self-healing when the
    // live cohort recovers). No NPI → truthful "needs_mapping" in the outbox.
    npiFor: (hcpId) => targeting.get(hcpId)?.npi,
  });
  // Self-healing audience source: a boot-time fallback to the modeled cohort (timeout,
  // expired token) retries on demand — throttled — and swaps the LIVE cohort back into
  // the same TargetingService instance every consumer already holds.
  const audienceState = { source: audienceSource, lastAttemptAt: Date.now() };
  const audienceRuntime = {
    get source() {
      return audienceState.source;
    },
    get degraded() {
      return audienceState.source.includes("fallback");
    },
    /** Retry the live provider when degraded (max once per 60s). True if healthy after the call. */
    async refresh(): Promise<boolean> {
      if (!audienceState.source.includes("fallback")) return true;
      if (Date.now() - audienceState.lastAttemptAt < 60_000) return false;
      audienceState.lastAttemptAt = Date.now();
      const next = await loadCohort(audienceQueryFor(await resolvedClinical()));
      if (!next.source.includes("fallback")) {
        targeting.replaceCohort(next.cohort);
        audienceState.source = next.source;
        console.info(`[audience] live cohort recovered: ${next.source} (${next.cohort.length} HCPs)`);
        return true;
      }
      return false;
    },
    /** Re-query the cohort NOW with the current resolved brand targeting — called when
     *  the Setup Assistant changes target_specialties / diagnosis_codes. */
    async reloadForBrandChange(): Promise<void> {
      const next = await loadCohort(audienceQueryFor(await resolvedClinical()));
      targeting.replaceCohort(next.cohort);
      audienceState.source = next.source;
      console.info(`[audience] cohort re-queried for brand targeting change: ${next.source} (${next.cohort.length} HCPs)`);
    },
  };
  const metrics = new RuntimeMetrics();
  const analytics = new AnalyticsService({ sessions, followups, crm, content, targeting, metrics, audit, targetTopics: brand.targetTopics ?? [] });
  // MLR review loop: on approval, publish the answer to retrieval so the rep can
  // cite it. Nothing parsed/ingested is retrievable until it clears this gate.
  const mlr = new MlrService(content, async (a) => {
    await index.upsert({ refId: a.id, metadata: { audience: a.mlr.audience, indication: a.mlr.indication, market: a.mlr.market }, text: `${a.topic} ${a.text}` });
  });

  // Approved content (asset, slides, answers, ISI) + the rebuilt retrieval index — seeded for
  // "demo"/default containers, skipped for "clean" ones (they ingest their own through MLR).
  if (seedContent) {
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
  // Seed-if-absent: the durable store is the source of truth across restarts. Re-seeding
  // over existing records would RESURRECT content MLR reviewers retired/superseded (a
  // compliance bug: the Postgres driver's insert is an upsert).
  if (!(await content.getAsset(assetId))) await content.addAsset(asset);

  for (const [i, s] of brand.deck.entries()) {
    const slideId = asId<"detail_aid_slide_id">(s.id) as DetailAidSlideId;
    const existingSlide = await content.getSlide(slideId);
    // Add if absent; also keep code-authored slide fields in sync on a persistent store (a new
    // slide, a retitled/re-ordered one) so a richer deck actually shows instead of a stale one.
    if (existingSlide && existingSlide.title === s.title && existingSlide.label === s.label && existingSlide.position === i + 1) continue;
    await content.addSlide({
      id: slideId,
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
    const answerId = asId<"approved_answer_id">(a.id) as ApprovedAnswer["id"];
    const slideId = asId<"detail_aid_slide_id">(a.detailAidSlideId) as DetailAidSlideId;
    const existing = await content.getAnswer(answerId);
    if (!existing) {
      await content.addAnswer({
        id: answerId, tenantId, brandId, campaignId, contentAssetId: assetId,
        topic: a.topic, text: a.text, detailAidSlideId: slideId, mlr: activeMlr(a.id),
      });
    } else if (existing.detailAidSlideId !== slideId || existing.text !== a.text || existing.topic !== a.topic) {
      // Seed content is CODE-authored, so the code is its source of truth: keep the durable store in
      // sync when the code changes (a remapped slide, edited wording) even on a persistent DB where
      // the record already exists — otherwise seed edits silently never take effect. PRESERVE the
      // existing MLR record so this can never REACTIVATE content a reviewer retired; it only syncs
      // the authored fields of an answer that is already present.
      await content.addAnswer({
        id: answerId, tenantId, brandId, campaignId, contentAssetId: assetId,
        topic: a.topic, text: a.text, detailAidSlideId: slideId, mlr: existing.mlr,
      });
    }
  }

  // REBUILD the retrieval index from the canonical store (the index is an in-memory,
  // rebuildable cache — brief §4). Every ACTIVE answer re-enters it: seeded content,
  // approved uploads, and MLR-approved revisions. Without this, a restart silently
  // dropped everything approved after boot from retrieval (found live: a revised
  // mechanism passage stopped being retrievable after a dev-server restart).
  for (const a of await content.listAnswers()) {
    if (a.mlr.status !== "active") continue;
    await index.upsert({
      refId: String(a.id),
      metadata: { audience: a.mlr.audience, indication: a.mlr.indication, market: a.mlr.market },
      text: `${a.topic} ${a.text}`,
    });
  }
  // Embed the approved deck during container warmup, not on the first Tavus/HCP turn. The vector
  // index is a rebuildable cache; this just materializes its vectors from canonical approved rows.
  await index.warmup();

  const isi: SafetyStatement = {
    id: asId<"safety_statement_id">("isi_main") as SafetyStatement["id"],
    tenantId,
    brandId,
    campaignId,
    text: brand.isiText,
    mlr: activeMlr("isi"),
  };
  if (!(await content.getSafetyStatement(isi.id))) await content.addSafetyStatement(isi);
  } // end if (seedContent)

  // Fake past sessions/follow-ups only when explicitly demoing (NEXUSREP_SEED_HISTORY=1
  // or an explicit createContainer({ seedHistory:true }) — used by tests). Off by
  // default so Sessions / Analytics / Follow-ups show ONLY real conversations.
  if (seedHistory) {
    await seedDemoHistory({ sessions, followups, crm, audit, aiRepId, brandId, campaignId });
  }
  // The rep: a full launch-ready build (persona, guardrails, sign-off, live) for "demo"/default
  // containers, or a bare DRAFT for "clean" users so their Studio renders (not a null snapshot)
  // and they build it from scratch via the Setup Assistant.
  if (seedStudioMode === "full") await seedDemoStudio({ studio, aiRepId, brandId, campaignId, brand });
  else await seedDraftStudio({ studio, aiRepId, brandId, campaignId, brand });

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
    audienceRuntime,
    demo: { tenantId, brandId, campaignId, aiRepId, hcpId, sessionId, audience, indication, market, audienceSource, investigational: brand.clinical.investigational },
  };
}

type ContainerGlobal = typeof globalThis & {
  __nexusrepContainers?: Map<string, Promise<AppContainer>>;
};

const containerGlobal = globalThis as ContainerGlobal;

function containerCache(): Map<string, Promise<AppContainer>> {
  if (!containerGlobal.__nexusrepContainers) containerGlobal.__nexusrepContainers = new Map();
  return containerGlobal.__nexusrepContainers;
}

/** Each signed-in user gets an ISOLATED store. On a Postgres driver (managed node-pg OR embedded
 *  PGlite) it's a per-user TABLE NAMESPACE (u_<user>_*) in the ONE shared database, so their data
 *  PERSISTS across restarts and no user can read another's rows; otherwise an isolated in-memory
 *  store (resets on restart — fine for local/dev). Same 3-way driver precedence as the default store. */
function perUserRepos(userId: string): RepositoryFactory {
  return makeRepositoryFactory(`u_${userId.toLowerCase().replace(/[^a-z0-9]/g, "_")}_`);
}

/** Build options for a signed-in user, or {} for the shared default (auth off / public doctor
 *  link — unchanged single-tenant behavior on the env driver). "demo" users clone the full seeded
 *  demo; "clean" users get a bare draft studio to build from scratch. */
function optsForUser(userId: string | null): Parameters<typeof createContainer>[0] {
  if (!userId) return {};
  return userData(userId) === "demo"
    ? { seedHistory: true, seedContent: true, seedStudio: "full", repos: perUserRepos(userId) }
    : { seedHistory: false, seedContent: false, seedStudio: "draft", repos: perUserRepos(userId), brand: BLANK_PROFILE };
}

/** Per-user container cache. Key "__default__" is the shared (auth-off / doctor-link) container. */
export function getContainerForUser(userId: string | null): Promise<AppContainer> {
  const key = userId ?? "__default__";
  const cache = containerCache();
  if (!cache.has(key)) {
    cache.set(key, createContainer(optsForUser(userId)).catch((error) => { cache.delete(key); throw error; }));
  }
  return cache.get(key)!;
}

/** Drain EVERY live container's CRM outbox (each user owns its own), retrying failed deliveries with
 *  backoff + attempt cap. Called on a timer by instrumentation.ts. Best-effort + isolated: a flush
 *  failure on one container never blocks another. Returns the number of entries acted on. */
export async function flushAllOutboxes(): Promise<number> {
  let acted = 0;
  for (const promise of containerCache().values()) {
    const c = await promise.catch(() => null);
    if (!c) continue;
    try {
      acted += (await c.crm.flush()).length;
    } catch {
      /* best-effort per container */
    }
  }
  return acted;
}

/** Resolve the signed-in user from the request cookie. Request-scoped via next/headers; returns
 *  null when auth is off or when called outside a request (e.g. tests) so we fall back to the
 *  shared default. Exported so the realtime call can record WHICH container owns the call's
 *  session, letting the vendor's cookie-less callback (/api/tavus/llm) reload the SAME one. */
export async function currentUserId(): Promise<string | null> {
  if (!appAuthEnabled()) return null;
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    return usernameFromCookie(jar.get(SESSION_COOKIE)?.value);
  } catch {
    return null;
  }
}

/** The container for the CURRENT request's signed-in user (or the shared default). Routes are
 *  unchanged: getContainer() now transparently returns the right per-user container. */
export function getContainer(): Promise<AppContainer> {
  return currentUserId().then(getContainerForUser);
}
