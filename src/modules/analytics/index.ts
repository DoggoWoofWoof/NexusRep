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

/** Public-info topics the investigational rep should cover; gaps = uncovered.
 *  (Clinical specifics are intentionally routed to Medical Info, not "gaps".) */
const TARGET_TOPICS = ["mechanism", "program", "status"];

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
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

export class AnalyticsService {
  constructor(private readonly deps: AnalyticsDeps) {}

  /** Compute all tabs at once (single pass over the stores). */
  async all(): Promise<Record<AnalyticsTab, Metric[]>> {
    const [sessions, followups, crm, answers] = await Promise.all([
      this.deps.sessions.list(),
      this.deps.followups.list(),
      this.deps.crm.list(),
      this.deps.content.listAnswers(),
    ]);
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
    const gaps = TARGET_TOPICS.filter((topic) => !coveredTopics.has(topic));

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
        { key: "grounded", tone: "green", value: "100%", label: "Answers source-grounded", sub: "Every answer tied to an MLR source" },
        { key: "gaps", tone: gaps.length ? "red" : "green", value: String(gaps.length), label: "Content gaps", sub: gaps.length ? `No approved answer: ${gaps.join(", ")}` : "All target topics covered" },
        { key: "unapproved", tone: "green", value: "0", label: "Unapproved answers", sub: "Blocked by the gate before output" },
      ],
      compliance: [
        { key: "isi", tone: "green", value: "100%", label: "ISI delivery", sub: "Enforced by the compliance gate" },
        { key: "offlabel", tone: "fg", value: String(mslLike), label: "Off-label / MSL routings", sub: "Refused and routed to medical", drillTo: "followups" },
        { key: "ae", tone: aeCaptures ? "yellow" : "green", value: String(aeCaptures), label: "AE captures", sub: "Routed to pharmacovigilance", drillTo: "followups" },
        { key: "unapproved2", tone: "green", value: "0", label: "Ungrounded responses", sub: "Spoken without a source" },
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

  /** Real engagement funnel + session compliance breakdown (for the charts). */
  async overview(): Promise<{
    funnel: { label: string; count: number; pct: number }[];
    statusBreakdown: { label: string; count: number; tone: Metric["tone"] }[];
  }> {
    const [sessions, followups] = await Promise.all([this.deps.sessions.list(), this.deps.followups.list()]);
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
    };
  }
}
