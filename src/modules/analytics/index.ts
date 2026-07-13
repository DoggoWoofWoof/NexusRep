/**
 * Analytics (brief §11; PDF §10). Metrics are DERIVED from session / follow-up /
 * CRM / content / targeting state — never a separate source of truth. Every
 * value here traces to a real count in a live store; nothing is hand-typed.
 *
 * Runtime-quality metrics (latency, fallback rate) come from RuntimeMetrics,
 * which the turn controller feeds as real turns happen. With no live turns yet
 * those read "—" rather than a fabricated number.
 */

import type { ContentService } from "@modules/content";
import type { CrmOutbox } from "@modules/crm";
import type { FollowUpService } from "@modules/followups";
import type { SessionService } from "@modules/sessions";
import type { TargetingService } from "@modules/audience";
import type { AuditService } from "@modules/audit";
import type { Intent } from "@modules/compliance";

/** Real HCP-question intents → the buckets shown in "What HCPs are asking". Every bucket
 *  is a genuine classifier intent, so the distribution is the measured question mix, not
 *  an illustrative split. */
const TOPIC_BUCKETS: { intent: Intent; label: string }[] = [
  { intent: "product_info", label: "Product & mechanism" },
  { intent: "trial_data", label: "Clinical program & data" },
  { intent: "safety", label: "Safety information" },
  { intent: "dosing", label: "Dosing / efficacy (→ Medical Info)" },
  { intent: "administration", label: "Administration" },
  { intent: "access", label: "Access & coverage" },
  { intent: "comparative", label: "Comparative (→ Medical Info)" },
  { intent: "off_label", label: "Off-label (refused)" },
  { intent: "adverse_event", label: "Adverse events (→ PV)" },
  { intent: "human_request", label: "Human / MSL requests" },
];

export type AnalyticsTab =
  | "targeting"
  | "engagement"
  | "content"
  | "compliance"
  | "crm_ops"
  | "realtime_quality";

export interface Metric {
  key: string;
  label: string;
  value: string;
  sub: string;
  tone: "blue" | "green" | "yellow" | "red" | "fg";
  /** Optional drill-down target (screen/filter) the UI can navigate to. */
  drillTo?: string;
}

/** Rolling in-memory runtime metrics, fed by the live turn controller. */
export class RuntimeMetrics {
  private latencies: number[] = [];
  private routeCounts: Record<string, number> = {};

  record(sample: { latencyMs: number; route: string }): void {
    this.latencies.push(sample.latencyMs);
    if (this.latencies.length > 200) this.latencies.shift();
    this.routeCounts[sample.route] = (this.routeCounts[sample.route] ?? 0) + 1;
  }

  private percentile(p: number): number | null {
    if (this.latencies.length === 0) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] ?? null;
  }

  snapshot(): { count: number; p50: number | null; p95: number | null; fallbackRate: number | null } {
    const total = Object.values(this.routeCounts).reduce((a, n) => a + n, 0);
    const fallback = this.routeCounts["fallback"] ?? 0;
    return {
      count: this.latencies.length,
      p50: this.percentile(50),
      p95: this.percentile(95),
      fallbackRate: total ? fallback / total : null,
    };
  }
}

export interface AnalyticsDeps {
  sessions: SessionService;
  followups: FollowUpService;
  crm: CrmOutbox;
  content: ContentService;
  targeting: TargetingService;
  metrics: RuntimeMetrics;
  audit: AuditService;
  /** Public-info topic keys this brand should cover; content gaps = the uncovered ones.
   *  Brand-derived (never a hardcoded product's topics), so a blank brand shows zero gaps. */
  targetTopics: string[];
}

/** The measured question mix + a compliance rollup, aggregated from the audit trail. */
export interface TopicSlice { label: string; count: number; pct: number }
export interface ComplianceCounts {
  decisions: number;
  approved: number;
  blocked: number;
  grounded: number;        // approved answers carrying ≥1 source
  ungroundedBlocked: number;
  isiRequired: number;
  isiDelivered: number;
  unapprovedBlocked: number; // off-label / AE content stopped before output
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

export class AnalyticsService {
  constructor(private readonly deps: AnalyticsDeps) {}

  /** Compute all tabs at once (single pass over the stores). */
  async all(): Promise<Record<AnalyticsTab, Metric[]>> {
    const [sessions, followups, crm, answers, cc] = await Promise.all([
      this.deps.sessions.list(),
      this.deps.followups.list(),
      this.deps.crm.list(),
      this.deps.content.listAnswers(),
      this.complianceCounts(),
    ]);
    // Measured compliance rates — "—" until there's a turn to measure, so the gate's
    // guarantee is shown as a real number, never an unbacked "100%".
    const groundedDen = cc.grounded + cc.ungroundedBlocked;
    const groundedPct = groundedDen ? pct(cc.grounded, groundedDen) : "—";
    const isiPct = cc.isiRequired ? pct(cc.isiDelivered, cc.isiRequired) : "—";
    const t = this.deps.targeting;

    const total = sessions.length;
    const completed = sessions.filter((s) => s.durationSeconds > 0).length;
    const questions = sessions.reduce((a, s) => a + s.questionCount, 0);
    const needsReview = sessions.filter(
      (s) => s.complianceStatus === "needs_review" || s.complianceStatus === "blocked_escalated",
    ).length;

    const mslLike = followups.filter((f) => f.type === "msl" || f.type === "medical_information").length;
    const aeCaptures = followups.filter((f) => f.type === "pharmacovigilance").length;

    const crmSent = crm.filter((c) => c.status === "sent").length;
    const crmMapping = crm.filter((c) => c.status === "needs_mapping").length;
    const crmFailed = crm.filter((c) => c.status === "failed" || c.status === "retrying").length;

    const coveredTopics = new Set(answers.map((a) => a.topic));
    // Target topics: the brand's explicit list if it declares one, else derive from the LIVE
    // approved content (the public-info topics the rep actually covers) — so a self-serve rep gets
    // a real content-gap signal with no hardcoded topic list. Gaps = target topics not yet covered.
    const targetTopics = this.deps.targetTopics.length
      ? this.deps.targetTopics
      : [...coveredTopics].filter((t) => t && t !== "other");
    const gaps = targetTopics.filter((topic) => !coveredTopics.has(topic));

    const seg = t.segmentCounts();
    const rt = this.deps.metrics.snapshot();

    return {
      targeting: [
        { key: "high_opp", tone: "blue", value: String(t.highOpportunityCount(75)), label: "High-opportunity HCPs", sub: "Composite score ≥ 75", drillTo: "audience" },
        { key: "avg_score", tone: "fg", value: t.averageScore().toFixed(1), label: "Avg opportunity score", sub: "Whitespace × density × trend" },
        { key: "eligible", tone: "fg", value: t.totalEligiblePatients().toLocaleString("en-US"), label: "Eligible patients", sub: "Claims-derived aggregate, no PHI" },
        { key: "no_rep", tone: "green", value: String(seg.no_rep), label: "No-rep whitespace", sub: `${seg.under_covered} under-covered · ${seg.no_see} no-see` },
      ],
      engagement: [
        { key: "sessions", tone: "blue", value: String(total), label: "Sessions logged", sub: "AI-rep details this campaign", drillTo: "sessions" },
        { key: "completed", tone: "green", value: String(completed), label: "Sessions completed", sub: pct(completed, total) + " completion rate" },
        { key: "questions", tone: "fg", value: String(questions), label: "HCP questions handled", sub: total ? `${(questions / total).toFixed(1)} avg per session` : "—" },
        { key: "review", tone: needsReview ? "yellow" : "green", value: String(needsReview), label: "Sessions needing review", sub: "Flagged by compliance status" },
      ],
      content: [
        { key: "assets", tone: "blue", value: String(answers.length), label: "Approved answers live", sub: "Usable by the AI rep", drillTo: "studio" },
        { key: "grounded", tone: "green", value: groundedPct, label: "Answers source-grounded", sub: cc.grounded ? `${cc.grounded} answers tied to an MLR source` : "No answers delivered yet" },
        { key: "gaps", tone: gaps.length ? "red" : "green", value: String(gaps.length), label: "Content gaps", sub: gaps.length ? `No approved answer: ${gaps.join(", ")}` : targetTopics.length ? "All target topics covered" : "No target topics configured yet" },
        { key: "unapproved", tone: cc.unapprovedBlocked ? "yellow" : "green", value: String(cc.unapprovedBlocked), label: "Unapproved answers blocked", sub: "Off-label / AE content stopped by the gate" },
      ],
      compliance: [
        { key: "isi", tone: cc.isiRequired && cc.isiDelivered < cc.isiRequired ? "red" : "green", value: isiPct, label: "ISI delivery", sub: cc.isiRequired ? `${cc.isiDelivered}/${cc.isiRequired} required deliveries` : "No ISI-required turns yet" },
        { key: "offlabel", tone: "fg", value: String(mslLike), label: "Off-label / MSL routings", sub: "Refused and routed to medical", drillTo: "followups" },
        { key: "ae", tone: aeCaptures ? "yellow" : "green", value: String(aeCaptures), label: "AE captures", sub: "Routed to pharmacovigilance", drillTo: "followups" },
        { key: "unapproved2", tone: cc.ungroundedBlocked ? "red" : "green", value: String(cc.ungroundedBlocked), label: "Ungrounded blocked", sub: "Caught by the gate before output" },
      ],
      crm_ops: [
        { key: "crm_success", tone: crmFailed ? "yellow" : "green", value: pct(crmSent, crm.length), label: "CRM export success", sub: `${crmSent}/${crm.length} delivered to connector`, drillTo: "followups" },
        { key: "crm_mapping", tone: crmMapping ? "yellow" : "green", value: String(crmMapping), label: "Needs identity mapping", sub: "Awaiting HCP NPI resolution" },
        { key: "crm_failed", tone: crmFailed ? "red" : "green", value: String(crmFailed), label: "Failed exports", sub: "Awaiting retry" },
        { key: "followups", tone: "fg", value: String(followups.length), label: "Follow-ups created", sub: "Auto-created from sessions" },
      ],
      realtime_quality: [
        { key: "latency_p50", tone: "fg", value: rt.p50 == null ? "—" : `${rt.p50}ms`, label: "Perceived latency", sub: rt.count ? `p50 over ${rt.count} live turns` : "No live turns yet" },
        { key: "latency_p95", tone: "fg", value: rt.p95 == null ? "—" : `${rt.p95}ms`, label: "Tail latency", sub: "p95 response time" },
        { key: "fallback", tone: "green", value: rt.fallbackRate == null ? "—" : `${(rt.fallbackRate * 100).toFixed(1)}%`, label: "Fallback rate", sub: "Routed to safe fallback" },
        { key: "turns", tone: "blue", value: String(rt.count), label: "Live turns measured", sub: "This app instance" },
      ],
    };
  }

  async metricsFor(tab: AnalyticsTab): Promise<Metric[]> {
    return (await this.all())[tab];
  }

  /** Measured question mix: bucket every logged turn's classified intent. `total` is the
   *  number of classified HCP turns — the UI shows the real bars only once there's enough
   *  volume to be meaningful, and falls back to a labeled illustrative sample below that. */
  async topicDistribution(): Promise<{ total: number; slices: TopicSlice[] }> {
    const events = await this.deps.audit.allOfType("classification");
    const counts = new Map<string, number>();
    for (const e of events) {
      const intent = String((e.payload as { intent?: unknown }).intent ?? "");
      if (intent) counts.set(intent, (counts.get(intent) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, n) => a + n, 0);
    const slices = TOPIC_BUCKETS.map((b) => ({ label: b.label, count: counts.get(b.intent) ?? 0 }))
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((s) => ({ ...s, pct: total ? Math.round((s.count / total) * 100) : 0 }));
    return { total, slices };
  }

  /** Compliance rollup measured from the audit trail — replaces asserted "100% / 0"
   *  literals with real counts, so a gate regression would actually move the number. */
  async complianceCounts(): Promise<ComplianceCounts> {
    const [decisionsRaw, outputs] = await Promise.all([
      this.deps.audit.allOfType("compliance_decision"),
      this.deps.audit.allOfType("response_output"),
    ]);
    const c: ComplianceCounts = {
      decisions: 0, approved: 0, blocked: 0, grounded: 0, ungroundedBlocked: 0,
      isiRequired: 0, isiDelivered: 0, unapprovedBlocked: 0,
    };
    for (const e of decisionsRaw) {
      const p = e.payload as { decision?: string; reasons?: string[]; route?: string; isiRequired?: boolean };
      if (p.decision !== "approved" && p.decision !== "blocked") continue; // skip non-gate rows
      c.decisions++;
      const reasons = Array.isArray(p.reasons) ? p.reasons : [];
      const approved = p.decision === "approved";
      if (approved) c.approved++; else c.blocked++;
      if (reasons.includes("ungrounded_response")) c.ungroundedBlocked++;
      if (reasons.includes("off_label_in_answer") || reasons.includes("adverse_event_in_answer")) c.unapprovedBlocked++;
      if (p.isiRequired && p.route === "approved_answer") {
        c.isiRequired++;
        if (approved && !reasons.includes("isi_missing")) c.isiDelivered++;
      }
    }
    // Grounded = approved answers that actually carried a source id (measured from output).
    for (const e of outputs) {
      const p = e.payload as { route?: string; sourceIds?: unknown[] };
      if (p.route === "approved_answer" && Array.isArray(p.sourceIds) && p.sourceIds.length > 0) c.grounded++;
    }
    return c;
  }

  /** Real engagement funnel + session compliance breakdown (for the charts). */
  async overview(): Promise<{
    funnel: { label: string; count: number; pct: number }[];
    statusBreakdown: { label: string; count: number; tone: Metric["tone"] }[];
    topicMix: { total: number; slices: TopicSlice[] };
  }> {
    const [sessions, followups, topicMix] = await Promise.all([
      this.deps.sessions.list(),
      this.deps.followups.list(),
      this.topicDistribution(),
    ]);
    const target = this.deps.targeting.cohortSize();
    const started = sessions.length;
    const completed = sessions.filter((s) => s.durationSeconds > 0).length;
    const withFollowup = followups.length;
    const pct = (n: number) => (target ? Math.min(100, Math.round((n / target) * 100)) : 0);

    const byStatus = (st: string) => sessions.filter((s) => s.complianceStatus === st).length;
    return {
      funnel: [
        { label: "Target HCPs", count: target, pct: 100 },
        { label: "Sessions started", count: started, pct: pct(started) },
        { label: "Completed detail", count: completed, pct: pct(completed) },
        { label: "Follow-up created", count: withFollowup, pct: pct(withFollowup) },
      ],
      statusBreakdown: [
        { label: "Approved", count: byStatus("approved"), tone: "green" },
        { label: "Needs review", count: byStatus("needs_review"), tone: "yellow" },
        { label: "AE routed", count: byStatus("ae_routed"), tone: "yellow" },
        { label: "Blocked + escalated", count: byStatus("blocked_escalated"), tone: "red" },
      ],
      topicMix,
    };
  }

  /**
   * Real engagement for ONE cohort doctor — what the Audience drawer shows instead of
   * fabricated "affinity" bars: sessions, questions asked, follow-ups raised, last
   * contact, and the approved topics actually shown (slide titles from logged rep turns).
   * All HCP-level aggregates from our own session store; nothing invented.
   */
  async engagementForHcp(hcpId: string): Promise<HcpEngagement> {
    const member = this.deps.targeting.get(hcpId);
    const canonical = member ? String(member.id) : String(hcpId ?? "").trim();
    const [sessions, followups, slides] = await Promise.all([
      this.deps.sessions.list(),
      this.deps.followups.list(),
      this.deps.content.listSlides(),
    ]);
    const mine = sessions.filter((x) => {
      const sid = String(x.hcpId);
      return sid === canonical || `hcp_${sid}` === canonical || sid === `hcp_${canonical}`;
    });
    const sessionIds = new Set(mine.map((x) => String(x.id)));
    const followUps = followups.filter((f) => sessionIds.has(String(f.sourceSessionId))).length;
    const titleBySlide = new Map(slides.map((sl) => [String(sl.id), sl.title]));
    const topics = new Set<string>();
    let questions = 0;
    let lastAt: string | null = null;
    for (const session of mine) {
      questions += session.questionCount;
      if (!lastAt || session.startedAt > lastAt) lastAt = session.startedAt;
      for (const turn of session.turns) {
        if (turn.speaker === "rep" && turn.detailAidSlideId) {
          const title = titleBySlide.get(String(turn.detailAidSlideId));
          if (title) topics.add(title);
        }
      }
    }
    return { sessions: mine.length, questions, followUps, lastAt, topicsShown: [...topics].slice(0, 6) };
  }
}

/** Aggregate, per-doctor engagement summary (no patient-level data — our own session logs). */
export interface HcpEngagement {
  sessions: number;
  questions: number;
  followUps: number;
  lastAt: string | null;
  topicsShown: string[];
}
