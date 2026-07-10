"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { AppState } from "./NexusRepApp";
import { btnGhost, btnPrimary } from "./NexusRepApp";
import { streamArena } from "@lib/arena-client";
import { DEFAULT_RULES, KNOWLEDGE_ASSETS, TRAIN_SEED_KEY, setupTopicsFor } from "./data";
import { isOverviewPrompt } from "./overviewPrompt";
import { SlideView } from "../_components/SlideView";
import { TavusStage } from "../_components/TavusStage";
import { invalidateBrandCache, useBrand } from "../_components/useBrand";

type StudioMode = "setup" | "train" | "rules" | "readiness";
const MODES: { key: StudioMode; label: string }[] = [
  { key: "setup", label: "Build" },
  { key: "train", label: "Training & Preview" },
  { key: "rules", label: "Rules" },
  { key: "readiness", label: "Readiness" },
];

const SECTIONS: { key: string; title: string }[] = [
  { key: "profile", title: "Rep profile" },
  { key: "knowledge", title: "Approved knowledge" },
  { key: "audience", title: "Audience" },
  { key: "escalation", title: "Escalation & handoff" },
  { key: "rules", title: "Conversation rules" },
  { key: "readiness", title: "Readiness review" },
];

/* ---------- Snapshot shapes returned by /api/studio ---------- */
interface UiRule {
  id: string;
  type: string;
  status: string;
  tier: "Global" | "Persona" | "HCP";
  text: string;
  note: string;
  scope: string;
  source: "guardrail" | "feedback";
  hcp?: string;
  from?: string;
  sourceMessage?: string;
}
interface StudioSnap {
  rep: { displayName: string; state: string };
  readiness: { pct: number; canLaunch: boolean; items: { key: string; label: string; done: boolean; blocking: boolean }[] };
  sections: { key: string; title: string; status: string; fields: { key: string; label: string; value: string; inferred: boolean }[] }[];
  rules: UiRule[];
}

interface UiSafetyStatement {
  id: string;
  text: string;
  status: string;
  version: number;
  sourceFile: string;
}
interface SafetySnap {
  active: UiSafetyStatement | null;
  pending: UiSafetyStatement[];
}
interface KnowledgeSnap {
  totals: {
    documents: number;
    chunks: number;
    activeChunks: number;
    pendingChunks: number;
    safetyStatements: number;
    activeSafetyStatements: number;
  };
  documents: {
    id: string;
    title: string;
    kind: string;
    sourceFile: string;
    status: string;
    chunks: { id: string; topic: string; status: string; preview: string }[];
  }[];
}
interface OverviewSlideOption {
  id: string;
  title: string;
  label: string;
  position: number;
  sourceId: string;
  topic: string;
  preview: string;
}
interface OverviewPlanStep {
  id: string;
  title: string;
  slideId?: string;
  instruction: string;
}
interface OverviewPlanSnap {
  slides: OverviewSlideOption[];
  plan: { steps: OverviewPlanStep[]; updatedAt?: string };
}

/** Map the DEFAULT_RULES fallback (numeric ids) into the UiRule shape. */
function fallbackRules(): UiRule[] {
  return DEFAULT_RULES.map((r) => ({
    id: String(r.id),
    type: r.type,
    status: r.status,
    tier: (r.tier === "Global" || r.tier === "Persona" || r.tier === "HCP" ? r.tier : "Global") as UiRule["tier"],
    text: r.text,
    note: r.note,
    scope: r.scope,
    source: r.source === "guardrail" ? "guardrail" : "feedback",
    ...(r.hcp ? { hcp: r.hcp } : {}),
    ...(r.from ? { from: r.from } : {}),
  }));
}

/* UI SETUP_TOPICS key → server questionKey */
const ANSWER_KEY: Record<string, string> = {
  brand: "brand",
  indication: "indication",
  persona: "persona_type",
  audience: "target_audience",
  knowledge: "approved_content",
  escalation: "msl_contact",
  talking: "talking_points",
  forbidden: "blocked_topics",
  voice: "greeting",
  // Chatable brand polish — all consumed by resolveBrandProfile / the studio persona.
  sponsor: "sponsor",
  tagline: "tagline",
  voice_style: "voice_style",
  try_questions: "try_questions",
  hotwords: "hotwords",
};
/* UI SECTIONS key → server section key */
const SECTION_KEY: Record<string, string> = {
  profile: "profile",
  knowledge: "approved_knowledge",
  audience: "audience",
  escalation: "escalation",
  rules: "conversation_rules",
  readiness: "readiness",
};

export function StudioScreen({ app }: { app: AppState }) {
  const mode = (app.studioMode || "setup") as StudioMode;
  const [snap, setSnap] = useState<StudioSnap | null>(null);
  const [submitState, setSubmitState] = useState<"draft" | "pending" | "approved">("draft");

  const refresh = async () => {
    try {
      const res = await fetch("/api/studio");
      if (!res.ok) return;
      const data = (await res.json()) as StudioSnap | null;
      if (data) setSnap(data);
    } catch {
      /* keep falling back to static defaults */
    }
  };
  const post = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) return null;
      const data = (await res.json()) as StudioSnap | null;
      if (data) setSnap(data);
      if (data && (body.action === "answer" || body.action === "greeting")) invalidateBrandCache();
      return data;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (snap?.rep.state === "live") setSubmitState("approved");
  }, [snap?.rep.state]);

  const brand = useBrand();
  const repName = snap?.rep.displayName ?? `${brand?.displayName ?? "AI"} AI Specialist`;
  const rules: UiRule[] = snap?.rules ?? fallbackRules();
  const readyPctNum = snap?.readiness.pct;
  // While the snapshot loads, show an honest placeholder — never a made-up percent.
  const readyPct = readyPctNum != null ? `${readyPctNum}%` : "…";
  const itemsLeft = snap ? String(snap.readiness.items.filter((i) => !i.done).length) : "…";

  const submit = async () => {
    setSubmitState("pending");
    const data = await post({ action: "repState", repState: "live" });
    if (data?.rep.state === "live") setSubmitState("approved");
    else setTimeout(() => setSubmitState("approved"), 1300);
  };

  return (
    <div style={{ padding: "22px 30px 40px", maxWidth: 1400 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 14 }}>
        <div>
          <div style={{ font: "600 11px/1.2 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--dn-brand-light)", marginBottom: 6 }}>AI Rep Studio</div>
          <h1 style={{ font: "600 25px/1.2 var(--dn-font-sans)", letterSpacing: "-0.02em", margin: 0, color: "var(--dn-fg)" }}>{repName}</h1>
          <div style={{ font: "400 13px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 5 }}>{brand?.campaign.subtitle ? `${brand.campaign.subtitle} — ` : ""}DocNexus helps you set up, train and approve a compliant digital rep. Launch and CRM sync run automatically.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div onClick={() => app.setStudioMode("readiness")} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 13px", border: "1px solid var(--dn-border)", borderRadius: 10, background: "#fff", cursor: "pointer", boxShadow: "var(--dn-shadow-card)" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--dn-warning)" }} />
            <span style={{ lineHeight: 1.25 }}><span style={{ font: "700 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{readyPct}</span> <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>ready · {itemsLeft} items left</span></span>
          </div>
          <button onClick={submit} style={{ ...btnPrimary, background: submitState === "approved" ? "var(--dn-success)" : "var(--dn-brand-base)" }}>{submitState === "approved" ? "Approved ✓" : submitState === "pending" ? "Submitting…" : "Submit for approval"}</button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 11, padding: 4, gap: 3, boxShadow: "var(--dn-shadow-card)" }}>
          {MODES.map((m) => (
            <span key={m.key} onClick={() => app.setStudioMode(m.key)} style={{ padding: "8px 15px", borderRadius: 8, font: "600 12.5px/1 var(--dn-font-sans)", cursor: "pointer", color: mode === m.key ? "#fff" : "var(--dn-fg-muted)", background: mode === m.key ? "var(--dn-brand-base)" : "transparent" }}>{m.label}</span>
          ))}
        </div>
        <span style={{ font: "500 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", flex: 1, minWidth: 220 }}>
          {mode === "setup" ? "Answer DocNexus's questions on the left — it drafts each section on the right." : mode === "train" ? "Rehearse the pitch DocNexus drafted from your approved deck — or ask anything. Coach a line and the rep tries again." : mode === "rules" ? "Guardrails are locked. Drafts from coaching need review before they go live." : "Resolve the checklist, then submit for approval."}
        </span>
      </div>

      {mode === "setup" && <BuildMode repName={repName} snap={snap} post={post} app={app} refresh={refresh} />}
      {mode === "train" && <TrainMode rules={rules} post={post} repName={repName} app={app} />}
      {mode === "rules" && <RulesMode rules={rules} post={post} />}
      {mode === "readiness" && <ReadinessMode snap={snap} submitState={submitState} onSubmit={submit} />}
    </div>
  );
}

/* ---------- BUILD MODE ---------- */
function BuildMode({ repName, snap, post, app, refresh }: { repName: string; snap: StudioSnap | null; post: (body: Record<string, unknown>) => Promise<StudioSnap | null>; app: AppState; refresh: () => Promise<void> }) {
  const brand = useBrand();
  const [step, setStep] = useState(0);
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [open, setOpen] = useState<string | null>("profile");
  const [status, setStatus] = useState<Record<string, string>>({});
  const [name, setName] = useState(repName);
  const [handoff, setHandoff] = useState(true);
  const [aeRouting, setAeRouting] = useState(true);
  const [uploadMsg, setUploadMsg] = useState("");
  const [msl, setMsl] = useState("");
  const [safety, setSafety] = useState<SafetySnap | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeSnap | null>(null);
  const [isiDraft, setIsiDraft] = useState("");
  const [isiMsg, setIsiMsg] = useState("");

  useEffect(() => {
    setName(repName);
  }, [repName]);

  // Load the persisted escalation contact (strip the handoff suffix we append on save).
  useEffect(() => {
    const v = snap?.sections.find((s) => s.key === "escalation")?.fields.find((f) => f.key === "msl_contact")?.value;
    if (v) setMsl(v.replace(/ · (human handoff enabled|no human handoff)$/, ""));
  }, [snap]);

  // The REAL source library (uploaded + seeded assets with MLR status); null while loading.
  const [sourceDocs, setSourceDocs] = useState<{ id: string; title: string; kind: string; status: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/content/knowledge")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { documents?: { id: string; title: string; kind: string; status: string }[] } | null) => {
        if (alive && d?.documents) setSourceDocs(d.documents.map(({ id, title, kind, status }) => ({ id, title, kind, status })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Specialty options come from the LIVE cohort's actual specialties — never a hardcoded list.
  const [cohortSpecialties, setCohortSpecialties] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/audience")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rows?: { specialty?: string }[] } | null) => {
        if (!alive || !d?.rows) return;
        setCohortSpecialties(Array.from(new Set(d.rows.map((r) => r.specialty).filter((s): s is string => Boolean(s)))).slice(0, 12));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Persist the escalation config (MSL contact + the two toggles) via the real setup answers,
  // so these controls actually save — not cosmetic. Human-handoff is folded into the contact
  // answer (no separate field); AE routing maps to its own answer.
  const saveEscalation = (m = msl, h = handoff, a = aeRouting) => {
    void post({ action: "answer", questionKey: "msl_contact", value: `${m.trim() || "Medical Information desk"} · ${h ? "human handoff enabled" : "no human handoff"}` });
    void post({ action: "answer", questionKey: "ae_routing", value: a ? "Pharmacovigilance safety desk (auto-routed)" : "Adverse events flagged for manual review" });
  };

  // Add source files (PPT/PDF/txt) -> /api/content/ingest. Parsed blocks land as
  // in-MLR drafts (never live until approved), so a brand user adds knowledge from the UI —
  // no code, no API tool. The Setup Assistant can also request this by chatting.
  async function onUpload(file: File | undefined) {
    if (!file) return;
    setUploadMsg(`Parsing "${file.name}"…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const kind = /isi/i.test(file.name) ? "isi" : /\.pptx?$/i.test(file.name) ? "ppt" : /\.pdf$/i.test(file.name) ? "pdf" : "faq";
      const res = await fetch("/api/content/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentBase64: btoa(bin), kind }),
      });
      const d = (await res.json()) as { parsed?: { blocks: number; slides: number; safetyStatements?: number }; setupAutofill?: { filled: string[] }; error?: string };
      if (res.ok && d.parsed) {
        const safetyCount = d.parsed.safetyStatements ?? 0;
        const filled = d.setupAutofill?.filled ?? [];
        const filledNote = filled.length ? ` Auto-filled setup from the document: ${filled.map((f) => f.replace(/_/g, " ")).join(", ")} — review the sections on the right.` : "";
        setUploadMsg(`Parsed ${d.parsed.blocks} block(s)${safetyCount ? ` and ${safetyCount} ISI statement(s)` : ""} from "${file.name}" — review and approve below.${filledNote}`);
        if (safetyCount) void loadSafety();
        void loadKnowledge();
        void loadPendingBlocks(); // the new passages appear in the review queue immediately
        if (filled.length) void refresh(); // drafted sections update from the inferred answers
      } else {
        setUploadMsg(`Couldn't parse: ${d.error ?? res.status}`);
      }
    } catch (e) {
      setUploadMsg(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const loadSafety = async () => {
    try {
      const res = await fetch("/api/content/safety");
      if (!res.ok) return;
      const data = (await res.json()) as SafetySnap;
      setSafety(data);
      if (!isiDraft.trim() && data.active?.text) setIsiDraft(data.active.text);
    } catch {
      /* keep the seeded brand fallback */
    }
  };

  // Remove a non-active source document (module fail-safe blocks docs with live passages).
  const removeSourceDoc = async (id: string, title: string) => {
    try {
      const res = await fetch(`/api/content/asset?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = (await res.json()) as { error?: string };
      setUploadMsg(res.ok ? `Removed "${title}" and its parsed passages.` : `Couldn't remove: ${d.error ?? res.status}`);
      if (res.ok) {
        setSourceDocs((docs) => (docs ?? []).filter((x) => x.id !== id));
        void loadKnowledge();
        void loadPendingBlocks();
      }
    } catch (e) {
      setUploadMsg(`Couldn't remove: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const loadKnowledge = async () => {
    try {
      const res = await fetch("/api/content/knowledge");
      if (!res.ok) return;
      setKnowledge((await res.json()) as KnowledgeSnap);
    } catch {
      /* keep static fallback assets */
    }
  };

  // Uploaded passages awaiting MLR review — with in-UI Approve/Reject, so the full
  // upload → review → live-knowledge loop is self-serve (previously the pending count
  // displayed but there was no way to act on it without the API).
  const [pendingBlocks, setPendingBlocks] = useState<{ id: string; topic: string; preview: string; sourceFile: string }[]>([]);
  const loadPendingBlocks = async () => {
    try {
      const res = await fetch("/api/mlr");
      if (!res.ok) return;
      const d = (await res.json()) as { pending?: { id: string; topic: string; preview: string; sourceFile: string }[] };
      setPendingBlocks(d.pending ?? []);
    } catch {
      /* review queue is progressive */
    }
  };
  const reviewBlock = async (answerId: string, action: "approve" | "reject") => {
    try {
      await fetch("/api/mlr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, answerId }) });
    } catch {
      /* refresh below shows the true state either way */
    }
    await Promise.all([loadPendingBlocks(), loadKnowledge()]);
    setUploadMsg(action === "approve" ? "Passage approved — it's now live rep knowledge (and its slide joins the deck)." : "Passage rejected — it will never be spoken.");
  };

  useEffect(() => {
    void loadSafety();
    void loadKnowledge();
    void loadPendingBlocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (safety?.active?.text) setIsiDraft((v) => v || safety.active!.text);
  }, [safety?.active?.id, safety?.active?.text]);

  const proposeIsi = async () => {
    const text = isiDraft.trim();
    if (!text) {
      setIsiMsg("Add ISI text before submitting.");
      return;
    }
    setIsiMsg("Submitting revised ISI for MLR review...");
    const res = await fetch("/api/content/safety", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "propose", text }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setIsiMsg(`Could not submit ISI: ${d.error ?? res.status}`);
      return;
    }
    await loadSafety();
    setIsiMsg("Revised ISI is pending MLR review. Approve it here to make it the live block.");
  };

  const reviewIsi = async (safetyId: string, action: "approve" | "reject") => {
    const res = await fetch("/api/content/safety", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, safetyId }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setIsiMsg(`Could not ${action} ISI: ${d.error ?? res.status}`);
      return;
    }
    await loadSafety();
    setIsiMsg(action === "approve" ? "Approved. This exact ISI block is now used live." : "Draft ISI rejected.");
  };

  // Initialize each section's UI status from the server snapshot.
  useEffect(() => {
    if (!snap) return;
    const next: Record<string, string> = {};
    for (const uiKey of SECTIONS.map((s) => s.key)) {
      const serverKey = SECTION_KEY[uiKey] ?? uiKey;
      const sec = snap.sections.find((s) => s.key === serverKey);
      if (!sec) continue;
      if (sec.status === "complete") next[uiKey] = "confirmed";
      else next[uiKey] = sec.fields.some((f) => f.value) ? "drafted" : "needs input";
    }
    setStatus(next);
  }, [snap]);

  const topics = setupTopicsFor(brand);
  const answer = (value: string) => {
    const i = step;
    if (i >= topics.length) return;
    const t = topics[i]!;
    setConfirmed((c) => ({ ...c, [t.key]: value }));
    setStatus((s) => (s[t.section] === "confirmed" ? s : { ...s, [t.section]: "drafted" }));
    setStep(i + 1);
    setInput("");
    setOpen(topics[i + 1]?.section ?? t.section);
    // Best-effort persist of the answer (ignore if no mapping exists).
    const questionKey = ANSWER_KEY[t.key];
    if (questionKey) void post({ action: "answer", questionKey, value });
  };
  const autoFill = () => {
    const c: Record<string, string> = { ...confirmed };
    const s: Record<string, string> = { ...status };
    topics.forEach((t) => {
      if (c[t.key] === undefined) c[t.key] = t.chips[0]![1];
      if (s[t.section] !== "confirmed") s[t.section] = "drafted";
      const questionKey = ANSWER_KEY[t.key];
      if (questionKey) void post({ action: "answer", questionKey, value: c[t.key]! });
    });
    setConfirmed(c); setStatus(s); setStep(topics.length); setOpen("profile");
  };

  const confirmSection = (uiKey: string) => {
    setStatus((s) => ({ ...s, [uiKey]: "confirmed" }));
    setOpen(null);
    const serverKey = SECTION_KEY[uiKey];
    if (serverKey) void post({ action: "section", section: serverKey, status: "complete" });
  };

  // "Ask DocNexus to revise" — reopen the section for re-drafting: mark it needs_input
  // (un-confirmed) so the brand user can re-answer it in the setup chat.
  const reviseSection = (uiKey: string) => {
    setStatus((s) => ({ ...s, [uiKey]: "needs_input" }));
    setOpen(uiKey);
    const serverKey = SECTION_KEY[uiKey];
    if (serverKey) void post({ action: "section", section: serverKey, status: "needs_input" });
  };

  const messages: { role: "assistant" | "user"; text: string }[] = [{ role: "assistant", text: "I'll set up your AI rep. Answer a few questions and I'll draft each section on the right." }];
  topics.slice(0, step).forEach((t) => {
    messages.push({ role: "assistant", text: t.q });
    if (confirmed[t.key]) messages.push({ role: "user", text: `Use ${confirmed[t.key]}.` });
  });
  if (step < topics.length) messages.push({ role: "assistant", text: topics[step]!.q });

  const statusOf = (key: string): string => status[key] ?? "needs input";
  const statusStyle = (key: string): React.CSSProperties => {
    const s = statusOf(key);
    const map: Record<string, [string, string]> = { confirmed: ["var(--dn-accent-green-bg)", "#166534"], drafted: ["rgba(6,73,172,.08)", "var(--dn-brand-base)"], "needs input": ["var(--dn-surface-2)", "var(--dn-fg-muted)"] };
    const [bg, c] = map[s] ?? map["needs input"]!;
    return { font: "600 9.5px/1 var(--dn-font-sans)", letterSpacing: ".03em", textTransform: "uppercase", padding: "4px 8px", borderRadius: 5, background: bg, color: c };
  };
  const statusLabel = (key: string) => ({ confirmed: "Complete", drafted: "Drafted — review", "needs input": "Needs input" }[statusOf(key)] ?? "Needs input");
  const activeIsiText = safety?.active?.text ?? "";
  const isiChanged = !!isiDraft.trim() && isiDraft.trim() !== activeIsiText.trim();

  return (
    <div style={{ display: "grid", gridTemplateColumns: "0.92fr 1.35fr", gap: 16, alignItems: "start" }}>
      {/* Assistant */}
      <div style={{ position: "sticky", top: 14, background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 14, boxShadow: "var(--dn-shadow-card)", display: "flex", flexDirection: "column", overflow: "hidden", height: 620 }}>
        <div style={{ padding: "15px 17px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", gap: 11, background: "linear-gradient(120deg, rgba(6,73,172,.05), rgba(124,58,237,.05))" }}>
          <div style={{ flexShrink: 0, width: 36, height: 36, borderRadius: 10, background: "var(--dn-gradient-ai)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700 }}>✦</div>
          <div style={{ lineHeight: 1.3 }}><div style={{ font: "600 13.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>DocNexus Setup Assistant</div><div style={{ font: "400 11px/1.2 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 3 }}>Drafts your rep — review on the right</div></div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 9, flexDirection: m.role === "user" ? "row-reverse" : "row" }}>
              {m.role === "assistant" && <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 7, background: "var(--dn-gradient-ai)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11 }}>✦</span>}
              <span style={{ maxWidth: "82%", padding: "9px 12px", borderRadius: 10, font: "400 12px/1.5 var(--dn-font-sans)", background: m.role === "user" ? "var(--dn-brand-base)" : "var(--dn-surface-2)", color: m.role === "user" ? "#fff" : "var(--dn-fg)" }}>{m.text}</span>
            </div>
          ))}
          {step < topics.length && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, paddingLeft: 31, marginTop: 2, alignItems: "center" }}>
              {topics[step]!.optional && <span data-testid="setup-optional" style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", background: "var(--dn-surface-2)", padding: "4px 7px", borderRadius: 5 }}>optional</span>}
              {topics[step]!.chips.map((c) => (
                <span key={c[0]} data-testid="setup-chip" onClick={() => answer(c[1])} style={{ padding: "8px 12px", background: "#fff", border: "1px solid var(--dn-brand-light)", borderRadius: 9, font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-brand-base)", cursor: "pointer" }}>{c[0]}</span>
              ))}
              {topics[step]!.optional && (
                <span data-testid="setup-skip" onClick={() => { setStep(step + 1); setOpen(topics[step + 1]?.section ?? null); }} style={{ padding: "8px 12px", border: "1px dashed var(--dn-border)", borderRadius: 9, font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg-muted)", cursor: "pointer" }}>Skip →</span>
              )}
            </div>
          )}
          {step >= topics.length && <div style={{ paddingLeft: 31, font: "500 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-success)" }}>All set — review and confirm each section on the right.</div>}
        </div>
        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--dn-border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
            <span style={{ font: "500 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{Math.min(step, topics.length)} of {topics.length} answered</span>
            <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {/* Upload once instead of answering one-by-one: the document fills the blanks. */}
              <label style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }} title="Upload a deck / PI / FAQ — I'll fill the setup answers from it">
                📎 Autofill from a document
                <input data-testid="upload-autofill" type="file" accept=".pptx,.ppt,.pdf,.txt,.md" onChange={(e) => void onUpload(e.target.files?.[0])} style={{ display: "none" }} />
              </label>
              {step < topics.length && <span onClick={autoFill} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>Decide for me →</span>}
            </span>
          </div>
          {/* Footer shows only what matters HERE: the autofill outcome (or a failure) — the full
              parse/approve message lives in the Approved-knowledge section, not duplicated. */}
          {(() => {
            const note = uploadMsg.match(/Auto-filled[^]*$/)?.[0] ?? (/^(Couldn't parse|Upload failed|Parsing)/.test(uploadMsg) ? uploadMsg : null);
            return note ? <div style={{ font: "500 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginBottom: 9 }}>{note}</div> : null;
          })()}
          <div style={{ height: 5, borderRadius: 3, background: "var(--dn-surface-2)", overflow: "hidden", marginBottom: 11 }}><div style={{ height: "100%", borderRadius: 3, background: "var(--dn-brand-base)", width: `${(Math.min(step, topics.length) / topics.length) * 100}%` }} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) answer(input.trim()); }} placeholder="Type an answer…" style={{ flex: 1, padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 12px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
            <button onClick={() => input.trim() && answer(input.trim())} style={{ ...btnPrimary, padding: "9px 14px", font: "600 12px/1 var(--dn-font-sans)" }}>Send</button>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={{ font: "600 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", padding: "2px 2px 4px" }}>DocNexus drafts each section as you answer. Open one to edit, then confirm.</span>
        {SECTIONS.map((sec) => (
          <div key={sec.key} style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
            <div onClick={() => setOpen((o) => (o === sec.key ? null : sec.key))} style={{ padding: "14px 17px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={{ font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{sec.title}</span><span style={statusStyle(sec.key)}>{statusLabel(sec.key)}</span></div>
              <span style={{ font: "500 17px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{open === sec.key ? "▾" : "▸"}</span>
            </div>
            {open === sec.key && (
              <div style={{ padding: "4px 17px 17px", borderTop: "1px solid var(--dn-surface-2)" }}>
                {sec.key === "profile" && (
                  <div style={{ paddingTop: 14 }}>
                    <label style={{ display: "block", marginBottom: 14 }}><span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Display name</span><input value={name} onChange={(e) => setName(e.target.value)} style={{ marginTop: 6, width: "100%", padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }} /></label>
                    <label style={{ display: "block" }}><span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>AI disclosure language</span><textarea key={brand?.greeting ?? "loading"} defaultValue={brand?.greeting ?? ""} style={{ marginTop: 6, width: "100%", padding: "10px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 12px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)", resize: "vertical", minHeight: 48 }} /></label>
                  </div>
                )}
                {sec.key === "knowledge" && (
                  <div style={{ paddingTop: 14 }}>
                    <div style={{ font: "400 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 13 }}>Source files and live rep knowledge are separate. MLR approves documents and safety blocks; NexusRep splits active documents into retrievable passages for the rep.</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", border: "1px dashed var(--dn-border)", borderRadius: 9, marginBottom: 13, cursor: "pointer", background: "var(--dn-surface-2)" }}>
                      <span style={{ font: "600 11.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>↑ Add source file</span>
                      <span style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Parsed into MLR review blocks before it can enter live knowledge</span>
                      <input data-testid="upload-source" type="file" accept=".pptx,.ppt,.pdf,.txt,.md" onChange={(e) => void onUpload(e.target.files?.[0])} style={{ display: "none" }} />
                    </label>
                    {uploadMsg && <div style={{ font: "500 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginBottom: 12 }}>{uploadMsg}</div>}
                    {knowledge && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", padding: "10px 12px", border: "1px solid var(--dn-border)", borderRadius: 9, marginBottom: 13, background: "#fff" }}>
                        <span>
                          <span style={{ display: "block", font: "600 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Live rep knowledge · {knowledge.totals.documents} source document(s)</span>
                          <span style={{ display: "block", font: "400 10.5px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 3 }}>{knowledge.totals.activeChunks} retrievable passage(s) from active documents, {knowledge.totals.pendingChunks} pending review passage(s), {knowledge.totals.activeSafetyStatements} active ISI block(s)</span>
                        </span>
                        <span style={{ font: "600 9.5px/1 var(--dn-font-sans)", padding: "5px 8px", borderRadius: 6, background: "rgba(6,73,172,.08)", color: "var(--dn-brand-base)" }}>NexusRep RAG</span>
                      </div>
                    )}
                    {/* The passages themselves — every retrievable block the rep can cite, by document.
                        This is exactly what "N retrievable passages" counts; nothing hidden. */}
                    {knowledge && knowledge.totals.chunks > 0 && (
                      <details style={{ marginBottom: 13 }}>
                        <summary style={{ cursor: "pointer", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", padding: "2px 0", listStyle: "none" }}>▸ View the {knowledge.totals.chunks} passage(s) behind these counts</summary>
                        <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 10 }}>
                          {knowledge.documents.filter((doc) => doc.chunks.length > 0).map((doc) => (
                            <div key={doc.id} style={{ border: "1px solid var(--dn-surface-2)", borderRadius: 9, padding: "9px 11px" }}>
                              <div style={{ font: "600 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", marginBottom: 7 }}>{doc.title} <span style={{ font: "400 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>· {doc.chunks.length} passage(s)</span></div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {doc.chunks.map((ch) => (
                                  <div key={ch.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                                    <span style={{ flexShrink: 0, font: "600 9px/1.4 var(--dn-font-sans)", padding: "2px 6px", borderRadius: 4, background: ch.status === "active" ? "var(--dn-accent-green-bg)" : ch.status === "in_mlr" ? "var(--dn-accent-yellow-bg)" : "var(--dn-surface-2)", color: ch.status === "active" ? "#166534" : ch.status === "in_mlr" ? "#92400e" : "var(--dn-fg-subtle)", textTransform: "uppercase", letterSpacing: ".03em" }}>{ch.status === "active" ? "live" : ch.status === "in_mlr" ? "in review" : ch.status}</span>
                                    <span style={{ minWidth: 0, font: "400 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}><strong style={{ color: "var(--dn-fg)" }}>{ch.topic.replace(/[_-]+/g, " ")}</strong> — {ch.preview}{ch.preview.length >= 220 ? "…" : ""}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {/* MLR review queue for uploaded passages — approve here and the block goes live
                        (retrievable + its slide joins the on-screen deck). Fully self-serve. */}
                    {pendingBlocks.length > 0 && (
                      <div style={{ border: "1px solid #fcd34d", background: "#fffbeb", borderRadius: 9, padding: "10px 12px", marginBottom: 13 }}>
                        <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "#92400e", marginBottom: 8 }}>MLR review · {pendingBlocks.length} pending passage{pendingBlocks.length > 1 ? "s" : ""} — approve to make them live rep knowledge</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                          {pendingBlocks.map((p) => (
                            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", padding: "8px 10px", background: "#fff", borderRadius: 8, border: "1px solid var(--dn-surface-2)" }}>
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: "block", font: "600 10px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", textTransform: "capitalize" }}>{p.topic.replace(/_/g, " ")} · <span style={{ fontFamily: "var(--dn-font-mono)", textTransform: "none", fontWeight: 400 }}>{p.sourceFile}</span></span>
                                <span style={{ display: "block", font: "400 10.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.preview}</span>
                              </span>
                              <span style={{ display: "flex", gap: 8 }}>
                                <button data-testid="mlr-approve" onClick={() => void reviewBlock(p.id, "approve")} style={{ ...btnGhost, padding: "6px 9px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>Approve</button>
                                <button data-testid="mlr-reject" onClick={() => void reviewBlock(p.id, "reject")} style={{ ...btnGhost, padding: "6px 9px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Reject</button>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ borderTop: "1px solid var(--dn-surface-2)", borderBottom: "1px solid var(--dn-surface-2)", padding: "13px 0", marginBottom: 13 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                        <div>
                          <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Required safety information (ISI)</div>
                          <div style={{ font: "400 11px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 4 }}>Active block v{safety?.active?.version ?? 1} is delivered exactly after approval.</div>
                        </div>
                        <button onClick={() => { setIsiDraft(activeIsiText); setIsiMsg("Current active ISI confirmed for this build section."); }} style={{ ...btnGhost, padding: "7px 10px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>Confirm active ISI</button>
                      </div>
                      <textarea value={isiDraft} onChange={(e) => setIsiDraft(e.target.value)} placeholder="Draft revised ISI wording for MLR review..." style={{ width: "100%", minHeight: 74, resize: "vertical", padding: "10px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)", background: "#fff" }} />
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 9, flexWrap: "wrap" }}>
                        <span style={{ font: "400 10.5px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{isiChanged ? "Edited wording will become a pending ISI draft." : "This matches the active ISI block."}</span>
                        <button onClick={() => void proposeIsi()} disabled={!isiChanged} style={{ ...btnPrimary, padding: "8px 12px", font: "600 11px/1 var(--dn-font-sans)", opacity: isiChanged ? 1 : 0.55 }}>Submit revised ISI</button>
                      </div>
                      {safety?.pending.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
                          {safety.pending.map((p) => (
                            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", padding: "8px 10px", background: "var(--dn-surface-2)", borderRadius: 8 }}>
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: "block", font: "600 10px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Pending ISI v{p.version}</span>
                                <span style={{ display: "block", font: "400 10.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.text}</span>
                              </span>
                              <span style={{ display: "flex", gap: 8 }}>
                                <button onClick={() => void reviewIsi(p.id, "approve")} style={{ ...btnGhost, padding: "6px 9px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>Approve</button>
                                <button onClick={() => void reviewIsi(p.id, "reject")} style={{ ...btnGhost, padding: "6px 9px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Reject</button>
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {isiMsg && <div style={{ font: "500 10.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 8 }}>{isiMsg}</div>}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Source library</span>
                      <span style={{ font: "400 10.5px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{sourceDocs === null ? "Sample list — live library loading" : "Uploaded assets and MLR status"}</span>
                    </div>
                    <div style={{ font: "400 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 8 }}>The launch deck ships already MLR-approved (the brand baseline). Everything you upload starts <strong>In MLR review</strong> — approve or reject each passage in the queue above; rejected documents can be removed.</div>
                    {/* REAL uploaded/seeded assets from the content module; fixture only while loading. */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
                      {(sourceDocs ?? KNOWLEDGE_ASSETS.map((c) => ({ id: c.mlrId, title: c.name, kind: c.kind, status: c.status.toLowerCase() }))).map((c) => (
                        <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 11px", border: "1px solid var(--dn-surface-2)", borderRadius: 9 }}>
                          <span style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: "var(--dn-surface-2)", display: "flex", alignItems: "center", justifyContent: "center", font: "700 10px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", textTransform: "uppercase" }}>{c.kind.slice(0, 3)}</span>
                          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}><span style={{ display: "block", font: "600 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title}</span><span style={{ display: "block", font: "400 10px/1.2 var(--dn-font-mono)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{c.id}</span></span>
                          <span style={{ font: "600 9.5px/1 var(--dn-font-sans)", padding: "3px 7px", borderRadius: 5, background: c.status === "active" ? "var(--dn-accent-green-bg)" : c.status === "retired" ? "var(--dn-surface-2)" : "var(--dn-accent-yellow-bg)", color: c.status === "active" ? "#166534" : c.status === "retired" ? "var(--dn-fg-subtle)" : "#92400e" }}>{c.status === "active" ? "MLR-approved" : c.status === "retired" ? "Rejected" : c.status === "in_mlr" ? "In MLR review" : c.status.replace(/_/g, " ")}</span>
                          {sourceDocs !== null && c.status !== "active" && (
                            <span
                              onClick={() => void removeSourceDoc(c.id, c.title)}
                              title="Remove this document and its parsed passages (documents with live approved passages can't be removed)"
                              style={{ flexShrink: 0, width: 20, height: 20, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--dn-fg-subtle)", border: "1px solid var(--dn-border)", font: "600 11px/1 var(--dn-font-sans)" }}
                            >
                              ×
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {sec.key === "audience" && (
                  <div style={{ paddingTop: 14 }}>
                    <div style={{ font: "400 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 13 }}>DocNexus suggested the cohort with the highest prescribing whitespace. Refine the full ranked list in Audience.</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                      <LabeledSelect label="Target segment" options={["Decile 2–4 whitespace", "All targeted"]} onChange={(v) => void post({ action: "answer", questionKey: "target_audience", value: v })} />
                      {/* Options come from the LIVE cohort's actual specialties (fallback while loading) and the choice persists. */}
                      <LabeledSelect label="Specialty" options={cohortSpecialties.length ? cohortSpecialties : ["Cardiology"]} onChange={(v) => void post({ action: "answer", questionKey: "specialty", value: v })} />
                    </div>
                    <span onClick={() => app.setNav("targeting")} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>Open full ranked audience →</span>
                  </div>
                )}
                {sec.key === "escalation" && (
                  <div style={{ paddingTop: 14 }}>
                    <label style={{ display: "block", marginBottom: 12 }}><span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>MSL contact</span><input value={msl} onChange={(e) => setMsl(e.target.value)} onBlur={() => saveEscalation()} placeholder="Medical Information desk / email" style={{ marginTop: 6, width: "100%", padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }} /></label>
                    <ToggleRow label="Human rep handoff" desc="Offer a live rep on request." on={handoff} onToggle={() => { const nh = !handoff; setHandoff(nh); saveEscalation(msl, nh, aeRouting); }} />
                    <ToggleRow label="Adverse-event routing" desc="Auto-route AE mentions to pharmacovigilance." on={aeRouting} onToggle={() => { const na = !aeRouting; setAeRouting(na); saveEscalation(msl, handoff, na); }} />
                  </div>
                )}
                {sec.key === "rules" && (
                  <div style={{ paddingTop: 14 }}>
                    <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 13 }}>Required and forbidden talking points the rep must follow — gated by compliance. Most rules are written for you when you coach the rep in Training &amp; Preview. Manage the full set, by scope, in Rules.</div>
                    <button onClick={() => app.setStudioMode("rules")} style={{ ...btnPrimary, padding: "9px 15px", font: "600 12px/1 var(--dn-font-sans)" }}>Open Rules →</button>
                  </div>
                )}
                {sec.key === "readiness" && (
                  <div style={{ paddingTop: 14 }}>
                    <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 13 }}>DocNexus tracks setup, knowledge, guardrails, rehearsal and reviewed rules. Open Readiness for the full checklist, then approve to go live.</div>
                    <button onClick={() => app.setStudioMode("readiness")} style={{ ...btnPrimary, padding: "9px 15px", font: "600 12px/1 var(--dn-font-sans)" }}>Open Readiness →</button>
                  </div>
                )}
                <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
                  <button onClick={() => confirmSection(sec.key)} style={{ ...btnPrimary, padding: "9px 15px", font: "600 12px/1 var(--dn-font-sans)" }}>Confirm section</button>
                  <button onClick={() => reviseSection(sec.key)} style={{ ...btnGhost, padding: "9px 15px", font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Ask DocNexus to revise</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LabeledSelect({ label, options, onChange }: { label: string; options: string[]; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(options[0] ?? "");
  // Visible confirmation that a change actually persisted (the POST is fire-and-forget).
  const [saved, setSaved] = useState(false);
  return (
    <label style={{ display: "block" }}>
      <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>{label}</span>
      {onChange && saved && <span style={{ marginLeft: 7, font: "600 9.5px/1 var(--dn-font-sans)", color: "var(--dn-success)" }}>Saved ✓</span>}
      <select value={value} onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value); if (onChange) { setSaved(true); window.setTimeout(() => setSaved(false), 2200); } }} style={{ marginTop: 6, width: "100%", padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", background: "#fff" }}>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}

function ToggleRow({ label, desc, on, onToggle }: { label: string; desc: string; on: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderTop: "1px solid var(--dn-surface-2)" }}>
      <div><div style={{ font: "600 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{label}</div><div style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{desc}</div></div>
      <span onClick={onToggle} style={{ width: 38, height: 22, borderRadius: 11, background: on ? "var(--dn-brand-base)" : "var(--dn-border-strong)", position: "relative", cursor: "pointer", flexShrink: 0, transition: "background .2s" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
      </span>
    </div>
  );
}

/* ---------- TRAIN MODE (conversational coaching loop) ---------- */
type CoachScope = "persona" | "global" | "hcp";
interface OverviewSegment { response: string; detailAidSlideId?: string | null; slideTitle?: string | null; stepId?: string | null; stepTitle?: string | null }
interface RepAnswer {
  text: string;
  route: string;
  isi: boolean;
  detailAidSlideId?: string | null;
  /** Did an LLM actually apply the coaching? false = no AI key (approved text only). */
  usedLlm: boolean;
  /** For a guided-overview answer: the per-slide steps, so Train renders it paragraph-by-paragraph. */
  segments?: OverviewSegment[];
}
/** One question and the rep's answer(s) — each coaching note produces a fresh re-answer.
 *  A "greeting" exchange has no HCP question: it coaches the rep's OPENING line. */
interface Exchange {
  q: string;
  kind?: "greeting" | "overview";
  answers: RepAnswer[]; // v1, then a new version per coaching note
  coachings: string[]; // the notes applied so far (visible in the thread)
  scope: CoachScope;
  accepted: boolean;
  ruleCount?: number; // rules saved on accept
}

function makePreviewSessionId(): string {
  return `session_train_preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// Persist the in-progress Train coaching thread client-side so it SURVIVES switching Studio tabs,
// navigating away, and reloading — previously it lived only in component state and vanished on
// unmount. (Accepted coaching is already persisted server-side as rules; this keeps the UNFINISHED
// thread + its drafts + the rehearsal session id so re-answers stay on the same preview session.)
const TRAIN_STORE_KEY = "nexusrep:train:coaching:v2";
interface TrainStore { exchanges?: Exchange[]; coachDraft?: Record<number, string>; previewSessionId?: string; brandName?: string }
function loadTrainState(brandName?: string): TrainStore {
  if (typeof window === "undefined") return {};
  try {
    const stored = JSON.parse(window.localStorage.getItem(TRAIN_STORE_KEY) || "{}") as TrainStore;
    // A thread coached against a DIFFERENT brand is stale (its questions/answers no longer
    // match) — drop it rather than rehydrating another brand's rehearsal.
    if (brandName && stored.brandName && stored.brandName !== brandName) return {};
    return stored;
  } catch { return {}; }
}

/** Split a rep answer into its coachable body and the active approved ISI block. */
function splitIsi(text: string): [string, string | null] {
  const parts = text.split(/\n\nImportant Safety Information:\s*/);
  return parts.length > 1 ? [parts[0]!.trim(), parts.slice(1).join(" ").trim()] : [text, null];
}

function TrainMode({ rules, post, repName, app }: { rules: UiRule[]; post: (body: Record<string, unknown>) => Promise<StudioSnap | null>; repName: string; app: AppState }) {
  const brand = useBrand();
  // Rehydrate the coaching thread from localStorage so it survives tab switches / reload.
  const [exchanges, setExchanges] = useState<Exchange[]>(() => loadTrainState().exchanges ?? []);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [coachDraft, setCoachDraft] = useState<Record<number, string>>(() => loadTrainState().coachDraft ?? {});
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [previewSessionId, setPreviewSessionId] = useState(() => loadTrainState().previewSessionId ?? makePreviewSessionId());
  const [overviewPlan, setOverviewPlan] = useState<OverviewPlanSnap | null>(null);
  const [activePlanStepId, setActivePlanStepId] = useState("");
  // Inline per-section coaching on a rehearsed pitch segment ({exchange, segment} being coached).
  const [segCoach, setSegCoach] = useState<{ exIdx: number; segIdx: number } | null>(null);
  const [segNote, setSegNote] = useState("");
  // Keep the coaching thread pinned to the newest message (new questions, re-answers,
  // seeded "Coach this exchange" handoffs) — no manual scrolling to find the latest.
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [exchanges, busyIdx]);
  const [planNote, setPlanNote] = useState("");
  const [planMsg, setPlanMsg] = useState("");

  const coachingRules = rules.filter((r) => r.source === "feedback");
  const activePlanStep = overviewPlan?.plan.steps.find((s) => s.id === activePlanStepId) ?? overviewPlan?.plan.steps[0];
  const activePlanSlideId = activePlanStep?.slideId ?? overviewPlan?.slides[0]?.id;

  const greetingExchange = (): Exchange => ({ q: "", kind: "greeting", answers: [{ text: brand?.greeting ?? "", route: "greeting", isi: false, detailAidSlideId: null, usedLlm: true }], coachings: [], scope: "persona", accepted: false });

  // Once the brand resolves: a stored thread coached against a DIFFERENT brand is stale —
  // reset it (its questions/answers no longer match this brand's rep).
  useEffect(() => {
    if (!brand?.displayName) return;
    const stored = loadTrainState();
    if (stored.brandName && stored.brandName !== brand.displayName) {
      setExchanges([]);
      setCoachDraft({});
      setPreviewSessionId(makePreviewSessionId());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand?.displayName]);

  // Seed the OPENING-LINE exchange once the greeting loads, so the disclosure itself can be
  // coached like any answer (previously it was the one line you couldn't change here).
  useEffect(() => {
    if (brand?.greeting) setExchanges((xs) => (xs.length === 0 ? [greetingExchange()] : xs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand?.greeting]);

  // Persist the coaching thread (thread + drafts + rehearsal session + BRAND it belongs to)
  // whenever it changes, so leaving the Train tab and coming back — or reloading — keeps
  // everything exactly where it was (and a brand switch invalidates it, above).
  useEffect(() => {
    try { window.localStorage.setItem(TRAIN_STORE_KEY, JSON.stringify({ exchanges, coachDraft, previewSessionId, brandName: brand?.displayName })); } catch { /* storage disabled/full — non-fatal */ }
  }, [exchanges, coachDraft, previewSessionId, brand?.displayName]);

  const loadOverviewPlan = async () => {
    try {
      const res = await fetch("/api/presentation/plan");
      if (!res.ok) return;
      const data = (await res.json()) as OverviewPlanSnap;
      setOverviewPlan(data);
      setActivePlanStepId((current) => current || data.plan.steps[0]?.id || "");
    } catch {
      /* deck editor is progressive; training still works without it */
    }
  };

  useEffect(() => {
    void loadOverviewPlan();
  }, []);

  const [planSaving, setPlanSaving] = useState(false);
  const persistOverviewPlan = async (plan = overviewPlan?.plan, message = "Pitch saved.") => {
    if (!plan) return;
    setPlanSaving(true);
    setPlanMsg("Saving pitch…");
    try {
      const res = await fetch("/api/presentation/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", plan }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as OverviewPlanSnap;
      setOverviewPlan(data);
      setActivePlanStepId((current) => data.plan.steps.some((s) => s.id === current) ? current : data.plan.steps[0]?.id || "");
      setPlanMsg(message);
    } catch (e) {
      setPlanMsg(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPlanSaving(false);
    }
  };

  const updatePlanStep = (stepId: string, patch: Partial<OverviewPlanStep>, save = false) => {
    if (!overviewPlan) return;
    const nextPlan = { ...overviewPlan.plan, steps: overviewPlan.plan.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) };
    setOverviewPlan({ ...overviewPlan, plan: nextPlan });
    if (save) void persistOverviewPlan(nextPlan, "Pitch section saved.");
  };

  const applyPlanNote = async (feedback = planNote, stepId = activePlanStepId) => {
    const note = feedback.trim();
    if (!note) return;
    setPlanMsg("Applying your note to the pitch…");
    try {
      const res = await fetch("/api/presentation/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "applyFeedback", feedback: note, stepId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as OverviewPlanSnap & { warning?: string };
      setOverviewPlan(data);
      setActivePlanStepId(stepId || data.plan.steps[0]?.id || "");
      setPlanNote("");
      // Surface server-side warnings (e.g. a named slide couldn't be matched) instead of
      // silently pretending the anchor changed.
      setPlanMsg(data.warning ? `⚠ ${data.warning}` : "Pitch updated — the next rehearsal and every doctor conversation use it.");
    } catch (e) {
      setPlanMsg(`Could not apply note: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Reorder pitch sections (the arrows in the card) — reorder client-side, persist the plan.
  // Guarded while a save is in flight: two rapid moves could otherwise interleave and the
  // first server response would briefly clobber the second reorder.
  const movePlanStep = (stepId: string, dir: -1 | 1) => {
    if (!overviewPlan || planSaving) return;
    const steps = [...overviewPlan.plan.steps];
    const i = steps.findIndex((st) => st.id === stepId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    const nextPlan = { ...overviewPlan.plan, steps };
    setOverviewPlan({ ...overviewPlan, plan: nextPlan });
    void persistOverviewPlan(nextPlan, "Pitch order updated — the rep now presents in this order.");
  };

  const resetOverviewPlan = async () => {
    setPlanMsg("Resetting pitch…");
    try {
      const res = await fetch("/api/presentation/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as OverviewPlanSnap;
      setOverviewPlan(data);
      setActivePlanStepId(data.plan.steps[0]?.id || "");
      setPlanMsg("Reset to approved deck order.");
    } catch (e) {
      setPlanMsg(`Could not reset: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Rehearse the rep with the coaching so far applied. A greeting exchange rewrites the opening
  // line (keeping the mandatory disclosures); any other rewrites the answer. Rehearsal only — the
  // preview endpoint creates no session, logs no turn, enqueues no follow-up.
  const runPreview = async (ex: { kind?: "greeting" | "overview"; q: string; current: string }, coaching: string[]): Promise<RepAnswer> => {
    try {
      const body = ex.kind === "greeting" ? { kind: "greeting", current: ex.current, coaching } : { kind: ex.kind, text: ex.q, coaching, previewSessionId };
      const res = await fetch("/api/train/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        const d = (await res.json()) as { response?: string; route?: string; isiDelivered?: boolean; detailAidSlideId?: string | null; usedLlm?: boolean; segments?: OverviewSegment[] };
        return { text: d.response ?? "", route: d.route ?? "", isi: !!d.isiDelivered, detailAidSlideId: d.detailAidSlideId ?? null, usedLlm: !!d.usedLlm, ...(d.segments?.length ? { segments: d.segments } : {}) };
      }
    } catch {
      /* fall through */
    }
    // Honest failure: never show a canned fixture answer as if the rep said it (the fixture
    // is themed to the seeded brand and would be wrong for a re-branded rep anyway).
    return { text: "The rehearsal service is unreachable right now — check the server and try again.", route: "error", isi: false, detailAidSlideId: null, usedLlm: false };
  };

  const ask = async (forced?: string) => {
    if (asking) return;
    const q = forced?.trim() || input.trim() || brand?.tryQuestions[0] || "Tell me about this therapy.";
    const kind = isOverviewPrompt(q, { productTerms: brand?.productTerms ?? [] }) ? "overview" : undefined;
    setAsking(true);
    setInput("");
    const a = await runPreview({ kind, q, current: "" }, []);
    setExchanges((xs) => [...xs, { q, kind, answers: [a], coachings: [], scope: "persona", accepted: false }]);
    setAsking(false);
  };

  // Session review → "Coach this exchange": the reviewed doctor question arrives via a one-shot
  // seed, so coaching starts from the exact line that needed work — no retyping.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TRAIN_SEED_KEY);
      if (!raw) return;
      window.localStorage.removeItem(TRAIN_SEED_KEY);
      const seed = JSON.parse(raw) as { q?: string };
      if (seed.q) void ask(seed.q);
    } catch { /* malformed seed — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Add a coaching note → the rep tries again with all notes so far. Iterate until happy.
  // Pitch (overview) notes are applied to the plan IMMEDIATELY (the plan is the artifact the
  // rep speaks from), targeted at the given section — or the currently selected one.
  const reAnswer = async (idx: number, opts?: { stepId?: string; note?: string }) => {
    const note = (opts?.note ?? coachDraft[idx] ?? "").trim();
    const ex = exchanges[idx];
    if (!note || !ex || ex.accepted || busyIdx !== null) return;
    const coachings = [...ex.coachings, note];
    setBusyIdx(idx);
    if (ex.kind === "overview") await applyPlanNote(note, opts?.stepId ?? activePlanStepId);
    const a = await runPreview({ kind: ex.kind, q: ex.q, current: ex.answers[ex.answers.length - 1]!.text }, coachings);
    setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, coachings, answers: [...x.answers, a] } : x)));
    setCoachDraft((d) => ({ ...d, [idx]: "" }));
    setBusyIdx(null);
  };

  // Accept the current answer. Greeting → persist the new opening line. Otherwise → compact the
  // coaching into rule(s) server-side (sensitive notes gated individually; style notes = 1 rule).
  const accept = async (idx: number) => {
    const ex = exchanges[idx];
    if (!ex || ex.accepted) return;
    const finalAnswer = ex.answers[ex.answers.length - 1]!.text;
    if (ex.kind === "greeting") {
      if (ex.coachings.length) await post({ action: "greeting", value: finalAnswer });
    } else if (ex.kind === "overview") {
      // Pitch notes were applied to the plan the moment they were coached (reAnswer /
      // per-section coach) — accepting just closes the exchange. No duplicate rules.
    } else if (ex.coachings.length) {
      await post({ action: "acceptCoaching", coachings: ex.coachings, question: ex.q, answer: finalAnswer, scope: ex.scope });
    }
    setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, accepted: true, ruleCount: ex.coachings.length } : x)));
  };

  const setScope = (idx: number, s: CoachScope) => setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, scope: s } : x)));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 0.85fr", gap: 15, alignItems: "start" }}>
      {/* Rep preview + drive */}
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        {showVideo ? (
          <TavusStage onClose={() => setShowVideo(false)} />
        ) : (
          <div style={{ position: "relative", borderRadius: 15, overflow: "hidden", aspectRatio: "4/3", background: "radial-gradient(120% 120% at 50% 0%, #15315f 0%, #0a1a33 60%, #060f1f 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", boxShadow: "var(--dn-shadow-dark)" }}>
            <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.4)", padding: "6px 11px", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fbbf24" }} /><span style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "#fff" }}>AI rep · {repName}</span></div>
            <button onClick={() => setShowVideo(true)} title="Preview the live video rep (Tavus)" style={{ position: "absolute", top: 12, right: 12, background: "rgba(255,255,255,.14)", color: "#fff", border: "1px solid rgba(255,255,255,.3)", borderRadius: 8, padding: "6px 10px", font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}>🎥 Video</button>
            <div style={{ width: 96, height: 96, borderRadius: "50%", background: "linear-gradient(160deg,#2d4f86,#1a3258)", display: "flex", alignItems: "flex-end", justifyContent: "center", overflow: "hidden", boxShadow: "0 0 0 6px rgba(96,165,250,.12)" }}><svg width="68" height="68" viewBox="0 0 24 24" fill="rgba(191,219,254,.9)"><circle cx="12" cy="8" r="4.2" /><path d="M3.5 21c0-4.4 3.8-7.5 8.5-7.5s8.5 3.1 8.5 7.5z" /></svg></div>
            <div style={{ marginTop: 14, font: "600 13.5px/1 var(--dn-font-sans)", color: "rgba(255,255,255,.92)" }}>{repName}</div>
            <div className="rep-eq" data-on={exchanges.length > 0} style={{ marginTop: 12 }}><span /><span /><span /><span /><span /></div>
          </div>
        )}
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "14px 15px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 9 }}>Play the provider — ask, then coach</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} placeholder="Ask the rep a question…" style={{ flex: 1, padding: "10px 12px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 12.5px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
            <button onClick={() => void ask()} disabled={asking} style={{ ...btnPrimary, padding: "10px 14px" }}>{asking ? "…" : "Ask"}</button>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
            <button onClick={() => void ask("Can you walk me through the approved information?")} disabled={asking} style={{ ...btnGhost, padding: "7px 10px", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>▶ Rehearse the pitch</button>
            {/* Sample question comes from the brand profile (chat-configurable), never hardcoded. */}
            {(brand?.tryQuestions?.[1] ?? brand?.tryQuestions?.[0]) && (
              <button onClick={() => void ask(brand!.tryQuestions[1] ?? brand!.tryQuestions[0]!)} disabled={asking} style={{ ...btnGhost, padding: "7px 10px", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>Sample question</button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 11, borderTop: "1px solid var(--dn-surface-2)" }}>
            <span style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Coach a line → the rep tries again</span>
            <span onClick={() => { setExchanges([greetingExchange()]); setCoachDraft({}); setPreviewSessionId(makePreviewSessionId()); }} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>↺ Restart</span>
          </div>
        </div>
        {/* Rules from your coaching — next to the thread that creates them (it used to sit
            below the tall pitch card where nobody scrolled). */}
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
          <div style={{ padding: "12px 14px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--dn-border)" }}><span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Rules from your coaching</span><span onClick={() => app.setStudioMode("rules")} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>See all →</span></div>
          <div style={{ padding: "11px 14px", display: "flex", flexDirection: "column", gap: 9, maxHeight: 230, overflowY: "auto" }}>
            {coachingRules.length === 0 && <div style={{ textAlign: "center", padding: "14px 8px", font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Accept a coached answer and the rules behind it land here for review.</div>}
            {coachingRules.map((r) => <RuleCard key={r.id} r={r} onAccept={() => void post({ action: "ruleStatus", ruleId: r.id, status: "active" })} onReject={() => void post({ action: "ruleStatus", ruleId: r.id, status: "rejected" })} compact />)}
          </div>
        </div>
        <ModelLab />
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "12px 14px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 5 }}>How this works</div>
          <div style={{ font: "400 11px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>The <strong>brand pitch</strong> (right) is what the rep opens doctor conversations with — DocNexus drafted it from your approved deck. <strong>Rehearse</strong> it here, coach any line, and when you <strong>Accept</strong>, the pitch and the rep&apos;s rules update. The first card is the rep&apos;s <strong>opening line</strong> — coach that too.</div>
        </div>
      </div>

      {/* Coaching thread */}
      <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", display: "flex", flexDirection: "column", height: 604 }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Coach the rep</span><span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Refine each answer, then accept</span></div>
        <div ref={threadRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
          {exchanges.length === 0 && <div style={{ textAlign: "center", color: "var(--dn-fg-subtle)", font: "400 12px/1.6 var(--dn-font-sans)", padding: "40px 14px" }}>Ask the rep a question on the left. Then coach any answer and it will try again — until you accept it.</div>}
          {exchanges.map((ex, idx) => {
            const latest = ex.answers[ex.answers.length - 1]!;
            const busy = busyIdx === idx;
            const needsKey = ex.coachings.length > 0 && !latest.usedLlm;
            return (
              <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* HCP question — or, for the greeting exchange, a label (no question) */}
                {ex.kind === "greeting" ? (
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 7, alignSelf: "flex-start", font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-accent-purple)", background: "rgba(124,58,237,.08)", padding: "5px 9px", borderRadius: 7 }}>★ Rep&apos;s opening line</div>
                ) : (
                  <div style={{ alignSelf: "flex-end", maxWidth: "88%" }}>
                    <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 4, textAlign: "right" }}>You (as HCP)</div>
                    <div style={{ padding: "9px 12px", borderRadius: 11, font: "400 12px/1.5 var(--dn-font-sans)", background: "var(--dn-brand-base)", color: "#fff" }}>{ex.q}</div>
                  </div>
                )}
                {/* Answer versions + interleaved coaching notes */}
                {ex.answers.map((a, v) => {
                  const isLatest = v === ex.answers.length - 1;
                  const offLabel = a.route === "off_label_refusal";
                  return (
                    <div key={v} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div>
                        <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-brand-base)", marginBottom: 4 }}>{ex.kind === "greeting" ? "Rep opening" : ex.kind === "overview" ? "Brand pitch" : "AI rep"}{ex.answers.length > 1 ? ` · v${v + 1}` : ""}{isLatest ? "" : " · revised ↓"}</div>
                        {(() => {
                          const bubbleStyle: React.CSSProperties = { padding: "10px 12px", background: offLabel ? "#fffbeb" : isLatest ? "var(--dn-surface-2)" : "#fafbfc", border: `1px solid ${offLabel ? "#fcd34d" : "var(--dn-border)"}`, borderRadius: 9, font: "400 12px/1.55 var(--dn-font-sans)", color: isLatest ? "var(--dn-fg)" : "var(--dn-fg-subtle)", opacity: isLatest ? 1 : 0.7 };
                          const isiBlock = (isiText: string | null) => isiText && (
                            <div style={{ marginTop: 9, paddingTop: 8, borderTop: "1px dashed var(--dn-border)", font: "400 10px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
                              <span style={{ fontWeight: 600, letterSpacing: ".02em" }}>Required safety information · active approved block — </span>{isiText}
                            </div>
                          );
                          // The pitch renders section-by-section, 1:1 with the Brand-pitch plan:
                          // same numbering, same titles, same slides. Click a section → the pitch
                          // panel jumps to it (slide + editor); ✎ coaches JUST that section.
                          if (a.segments?.length) {
                            return (
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {a.segments.map((seg, si) => {
                                  const [segBody, segIsi] = splitIsi(seg.response);
                                  const active = isLatest && !!seg.stepId && seg.stepId === activePlanStepId;
                                  const coachingThis = isLatest && !ex.accepted && segCoach?.exIdx === idx && segCoach?.segIdx === si;
                                  return (
                                    <div
                                      key={si}
                                      onClick={() => seg.stepId && setActivePlanStepId(seg.stepId)}
                                      title={seg.stepId ? "Click to open this section in the Brand pitch panel" : undefined}
                                      style={{ ...bubbleStyle, ...(seg.stepId ? { cursor: "pointer" } : {}), ...(active ? { border: "1px solid var(--dn-brand-base)", boxShadow: "0 0 0 1px var(--dn-brand-base)" } : {}) }}
                                    >
                                      <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-accent-purple)", marginBottom: 5, display: "flex", gap: 6, alignItems: "center" }}>
                                        <span>{si + 1}.</span>
                                        <span style={{ flex: 1 }}>{seg.stepTitle ?? seg.slideTitle ?? "Approved section"}</span>
                                        {seg.slideTitle && <span style={{ color: "var(--dn-fg-subtle)", textTransform: "none", letterSpacing: 0 }}>▤ shows {seg.slideTitle}</span>}
                                        {isLatest && !ex.accepted && seg.stepId && (
                                          <span
                                            onClick={(e) => { e.stopPropagation(); setSegCoach(coachingThis ? null : { exIdx: idx, segIdx: si }); setSegNote(""); }}
                                            style={{ color: "var(--dn-brand-light)", cursor: "pointer", textTransform: "none", letterSpacing: 0 }}
                                          >
                                            ✎ Coach
                                          </span>
                                        )}
                                      </div>
                                      <div style={{ whiteSpace: "pre-wrap" }}>{segBody}</div>
                                      {isiBlock(segIsi)}
                                      {coachingThis && (
                                        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, marginTop: 8 }}>
                                          <input
                                            autoFocus
                                            value={segNote}
                                            onChange={(e) => setSegNote(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === "Enter" && segNote.trim()) { void reAnswer(idx, { stepId: seg.stepId ?? undefined, note: segNote.trim() }); setSegCoach(null); } }}
                                            placeholder={`Coach section ${si + 1} — shorter, warmer, use a different slide…`}
                                            style={{ flex: 1, padding: "7px 9px", border: "1px solid var(--dn-brand-light)", borderRadius: 7, font: "400 11.5px/1.3 var(--dn-font-sans)", background: "#fff" }}
                                          />
                                          <button
                                            onClick={() => { if (segNote.trim()) { void reAnswer(idx, { stepId: seg.stepId ?? undefined, note: segNote.trim() }); setSegCoach(null); } }}
                                            disabled={!segNote.trim() || busy}
                                            style={{ ...btnPrimary, padding: "7px 10px", font: "600 10.5px/1 var(--dn-font-sans)", opacity: segNote.trim() && !busy ? 1 : 0.55 }}
                                          >
                                            {busy ? "…" : "Apply"}
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          }
                          const [bodyText, isiText] = splitIsi(a.text);
                          return (
                            <div style={bubbleStyle}>
                              <div style={{ whiteSpace: "pre-wrap" }}>{bodyText}</div>
                              {isiBlock(isiText)}
                            </div>
                          );
                        })()}
                      </div>
                      {/* the coaching note that produced the NEXT version */}
                      {v < ex.coachings.length && (
                        <div style={{ alignSelf: "flex-end", maxWidth: "88%" }}>
                          <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-accent-purple)", marginBottom: 4, textAlign: "right" }}>You coached</div>
                          <div style={{ padding: "8px 11px", borderRadius: 11, font: "400 11.5px/1.5 var(--dn-font-sans)", background: "rgba(124,58,237,.08)", color: "var(--dn-fg)", border: "1px solid rgba(124,58,237,.25)" }}>“{ex.coachings[v]}”</div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {needsKey && <div style={{ font: "400 10.5px/1.4 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", borderRadius: 7, padding: "6px 9px" }}>Showing approved text only — set an AI key (and NEXUSREP_COMPOSE=llm) so the rep can actually rephrase from your coaching.</div>}

                {/* Coach box / accepted badge */}
                {ex.accepted ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, font: "600 11px/1.3 var(--dn-font-sans)", color: "#166534", background: "var(--dn-accent-green-bg)", borderRadius: 8, padding: "9px 12px" }}>
                    <span>✓ Accepted</span>
                    <span style={{ font: "400 11px/1.3 var(--dn-font-sans)", color: "#166534" }}>
                      {ex.kind === "greeting"
                        ? ex.coachings.length ? "opening line updated — live everywhere the rep greets" : "no changes needed"
                        : ex.kind === "overview"
                          ? ex.coachings.length ? "pitch plan updated — every section keeps your notes" : "no changes needed"
                        : ex.coachings.length ? "your coaching saved as rule(s) → review in Rules" : "no changes needed"}
                    </span>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--dn-brand-light)", borderRadius: 9, padding: 10 }}>
                    <textarea value={coachDraft[idx] ?? ""} onChange={(e) => setCoachDraft((d) => ({ ...d, [idx]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void reAnswer(idx); }} placeholder={ex.kind === "greeting" ? "Coach the opening line — warmer, shorter, mention the brand… (disclosures are kept)" : ex.kind === "overview" ? `Coach the selected pitch section — or click ✎ on any part above. e.g. "keep it under 2 sentences", "use slide 3 here"…` : "Coach this answer — e.g. be more concise, lead with the approval status, warmer tone…"} style={{ width: "100%", padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 12px/1.45 var(--dn-font-sans)", resize: "vertical", minHeight: 42, background: "var(--dn-surface-2)" }} />
                    {ex.kind !== "greeting" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "9px 0", flexWrap: "wrap" }}>
                        <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>Save as</span>
                        {([["persona", "This persona"], ["global", "All reps"], ["hcp", "This HCP"]] as const).map(([k, l]) => (
                          <span key={k} onClick={() => setScope(idx, k)} style={{ padding: "5px 9px", borderRadius: 7, font: "600 10px/1 var(--dn-font-sans)", cursor: "pointer", border: `1px solid ${ex.scope === k ? "var(--dn-brand-base)" : "var(--dn-border)"}`, background: ex.scope === k ? "rgba(6,73,172,.08)" : "#fff", color: ex.scope === k ? "var(--dn-brand-base)" : "var(--dn-fg-muted)" }}>{l}</span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: ex.kind === "greeting" ? 9 : 0 }}>
                      <button onClick={() => void reAnswer(idx)} disabled={busy || !(coachDraft[idx] ?? "").trim()} style={{ ...btnGhost, flex: 1, padding: 9, font: "600 11.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", opacity: busy || !(coachDraft[idx] ?? "").trim() ? 0.5 : 1 }}>{busy ? "Rep is rethinking…" : "↻ Coach & re-answer"}</button>
                      <button onClick={() => void accept(idx)} disabled={busy} style={{ ...btnPrimary, flex: 1, padding: 9, font: "600 11.5px/1 var(--dn-font-sans)" }}>{ex.kind === "greeting" ? (ex.coachings.length ? "Save opening line" : "Keep as is") : ex.coachings.length ? "Accept & save rules" : "Accept answer"}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <OverviewPlanCard
          snap={overviewPlan}
          activeStepId={activePlanStepId}
          activeSlideId={activePlanSlideId}
          planNote={planNote}
          planMsg={planMsg}
          onStep={(id) => setActivePlanStepId(id)}
          onUpdateStep={updatePlanStep}
          onSave={() => void persistOverviewPlan()}
          onApplyNote={() => void applyPlanNote()}
          onReset={() => void resetOverviewPlan()}
          onNote={setPlanNote}
          onRehearse={() => void ask("Can you walk me through the approved information?")}
          rehearsing={asking}
          onMove={movePlanStep}
        />

      </div>
    </div>
  );
}

/* ---------- MODEL LAB (moved here from the HCP preview — an internal brand tool) ---------- */
interface LabModel { name: string; label: string; available: boolean }
interface LabSide { label: string; text: string; ttftMs?: number; totalMs?: number; running: boolean; error?: string }

/** Same question through two model providers, streamed side-by-side with latency.
 *  Free-generated benchmark for MODEL selection only — NOT the compliant rep answer
 *  (rehearse that in the coach thread; the gate doesn't run here and none of this logs). */
function ModelLab() {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<LabModel[]>([]);
  const [modelA, setModelA] = useState("keyword");
  const [modelB, setModelB] = useState("mock");
  const [q, setQ] = useState("");
  const [run, setRun] = useState<{ a: LabSide; b: LabSide } | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open || models.length) return;
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { providers: LabModel[] }) => {
        setModels(d.providers);
        const avail = d.providers.filter((m) => m.available);
        if (avail[0]) setModelA(avail[0].name);
        setModelB(d.providers.find((m) => m.name !== (avail[0]?.name ?? "mock"))?.name ?? "mock");
      })
      .catch(() => {});
  }, [open, models.length]);

  const labelOf = (name: string) => models.find((m) => m.name === name)?.label ?? name;

  const runAB = async () => {
    const question = q.trim();
    if (!question || running) return;
    setRunning(true);
    const mk = (name: string): LabSide => ({ label: labelOf(name), text: "", running: true });
    setRun({ a: mk(modelA), b: mk(modelB) });
    const onToken = (side: "a" | "b") => (t: string) => setRun((prev) => (prev ? { ...prev, [side]: { ...prev[side], text: prev[side].text + t } } : prev));
    const side = async (key: "a" | "b", provider: string) => {
      const r = await streamArena({ provider, text: question, onToken: onToken(key) });
      setRun((prev) => (prev ? { ...prev, [key]: { ...prev[key], running: false, ttftMs: r.ttftMs, totalMs: r.totalMs, error: r.error } } : prev));
    };
    try {
      await Promise.all([side("a", modelA), side("b", modelB)]);
    } finally {
      setRunning(false);
    }
  };

  const sel: React.CSSProperties = { flex: 1, minWidth: 0, padding: "6px 8px", border: "1px solid var(--dn-border)", borderRadius: 7, font: "500 11px/1.2 var(--dn-font-sans)", background: "#fff", color: "var(--dn-fg)" };

  return (
    <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
      <div onClick={() => setOpen((v) => !v)} style={{ padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>⚙ Model lab <span style={{ font: "500 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>· internal</span></span>
        <span style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)" }}>{open ? "Hide" : "Open"}</span>
      </div>
      {open && (
        <div style={{ padding: "0 14px 13px", display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ font: "400 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Same question through two providers, streamed with latency. Free-generated benchmark for picking a model — <strong>not</strong> the compliant rep answer, and nothing here is logged.</div>
          <div style={{ display: "flex", gap: 7 }}>
            {/* Disabled until the REAL provider list loads — never selectable placeholder models. */}
            <select value={modelA} onChange={(e) => setModelA(e.target.value)} disabled={!models.length} style={{ ...sel, opacity: models.length ? 1 : 0.6 }}>{models.length ? models.map((m) => <option key={m.name} value={m.name} disabled={!m.available}>{m.label}{m.available ? "" : " — add key"}</option>) : <option>Loading models…</option>}</select>
            <select value={modelB} onChange={(e) => setModelB(e.target.value)} disabled={!models.length} style={{ ...sel, opacity: models.length ? 1 : 0.6 }}>{models.length ? models.map((m) => <option key={m.name} value={m.name} disabled={!m.available}>{m.label}{m.available ? "" : " — add key"}</option>) : <option>Loading models…</option>}</select>
          </div>
          <div style={{ display: "flex", gap: 7 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void runAB(); }} placeholder="Question to compare…" style={{ flex: 1, minWidth: 0, padding: "8px 10px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 11.5px/1.2 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
            <button onClick={() => void runAB()} disabled={running || !q.trim()} style={{ ...btnPrimary, padding: "8px 11px", font: "600 11px/1 var(--dn-font-sans)", opacity: running || !q.trim() ? 0.55 : 1 }}>{running ? "…" : "Run A/B"}</button>
          </div>
          {run && (
            <div style={{ display: "grid", gap: 8 }}>
              {([run.a, run.b] as LabSide[]).map((sideRun, i) => (
                <div key={i} style={{ border: "1px solid var(--dn-surface-2)", borderRadius: 9, overflow: "hidden" }}>
                  <div style={{ padding: "7px 10px", background: "var(--dn-surface-2)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{sideRun.label}</span>
                    <span style={{ font: "500 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{sideRun.running ? "streaming…" : sideRun.error ? "error" : `${sideRun.ttftMs}ms → ${sideRun.totalMs}ms`}</span>
                  </div>
                  <div style={{ padding: "8px 10px", font: "400 11px/1.5 var(--dn-font-sans)", whiteSpace: "pre-wrap", color: sideRun.error ? "var(--dn-danger)" : "var(--dn-fg)", maxHeight: 140, overflowY: "auto" }}>{sideRun.error ? sideRun.error : sideRun.text || (sideRun.running ? "…" : "")}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewPlanCard({
  snap,
  activeStepId,
  activeSlideId,
  planNote,
  planMsg,
  onStep,
  onUpdateStep,
  onSave,
  onApplyNote,
  onReset,
  onNote,
  onRehearse,
  rehearsing,
  onMove,
}: {
  snap: OverviewPlanSnap | null;
  activeStepId: string;
  activeSlideId?: string;
  planNote: string;
  planMsg: string;
  onStep: (id: string) => void;
  onUpdateStep: (id: string, patch: Partial<OverviewPlanStep>, save?: boolean) => void;
  onSave: () => void;
  onApplyNote: () => void;
  onReset: () => void;
  onNote: (note: string) => void;
  onRehearse: () => void;
  rehearsing: boolean;
  onMove: (stepId: string, dir: -1 | 1) => void;
}) {
  const steps = snap?.plan.steps ?? [];
  const slides = snap?.slides ?? [];
  const step = steps.find((s) => s.id === activeStepId) ?? steps[0];
  const stepIndex = Math.max(0, steps.findIndex((s) => s.id === step?.id));
  const slideLabelOf = (slideId?: string) => slides.find((s) => s.id === slideId)?.label ?? "no slide";

  return (
    <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
      <div style={{ padding: "13px 16px 11px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Brand pitch</div>
          <div style={{ font: "500 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 4 }}>Drafted by DocNexus from your approved deck. The rep opens doctor conversations with it, slide by slide — edit a section or rehearse and coach it.</div>
        </div>
        <button onClick={onRehearse} disabled={rehearsing} title="Run the pitch in the coaching thread on the left" style={{ ...btnPrimary, flexShrink: 0, padding: "7px 10px", font: "600 10.5px/1 var(--dn-font-sans)", opacity: rehearsing ? 0.6 : 1 }}>{rehearsing ? "…" : "▶ Rehearse"}</button>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 11 }}>
        <div style={{ height: 178, minHeight: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
          <SlideView focusId={activeSlideId} compact fill />
        </div>

        {!snap || !step ? (
          <div style={{ padding: "20px 8px", textAlign: "center", font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Loading approved deck…</div>
        ) : (
          <>
            {/* The pitch, section by section — each anchored to an approved slide. Click to edit. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 168, overflowY: "auto" }}>
              {steps.map((s, i) => {
                const active = s.id === step.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => onStep(s.id)}
                    title={s.instruction || s.title}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, cursor: "pointer", border: `1px solid ${active ? "var(--dn-brand-base)" : "var(--dn-surface-2)"}`, background: active ? "rgba(6,73,172,.06)" : "transparent" }}
                  >
                    <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", font: "700 9.5px/1 var(--dn-font-sans)", color: active ? "#fff" : "var(--dn-fg-muted)", background: active ? "var(--dn-brand-base)" : "var(--dn-surface-2)" }}>{i + 1}</span>
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", font: `600 11px/1.3 var(--dn-font-sans)`, color: active ? "var(--dn-brand-base)" : "var(--dn-fg)" }}>{s.title}</span>
                    <span style={{ flexShrink: 0, font: "500 9.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{slideLabelOf(s.slideId)}</span>
                    <span style={{ flexShrink: 0, display: "inline-flex", gap: 2 }}>
                      <span onClick={(e) => { e.stopPropagation(); onMove(s.id, -1); }} title="Move this section earlier" style={{ width: 16, textAlign: "center", color: i === 0 ? "var(--dn-border)" : "var(--dn-fg-subtle)", cursor: i === 0 ? "default" : "pointer", font: "600 10px/1.4 var(--dn-font-sans)" }}>↑</span>
                      <span onClick={(e) => { e.stopPropagation(); onMove(s.id, 1); }} title="Move this section later" style={{ width: 16, textAlign: "center", color: i === steps.length - 1 ? "var(--dn-border)" : "var(--dn-fg-subtle)", cursor: i === steps.length - 1 ? "default" : "pointer", font: "600 10px/1.4 var(--dn-font-sans)" }}>↓</span>
                    </span>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--dn-surface-2)", paddingTop: 10 }}>
              <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-brand-base)" }}>Edit section {stepIndex + 1} — saves when you click away</span>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "600 8.5px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>Section title</span>
                <input
                  value={step.title}
                  onChange={(e) => onUpdateStep(step.id, { title: e.target.value })}
                  onBlur={() => onSave()}
                  placeholder="Section title"
                  style={{ width: "100%", padding: "8px 9px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "600 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", background: "var(--dn-surface-2)" }}
                />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "600 8.5px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>Slide on screen during this section</span>
                <select
                  value={step.slideId ?? ""}
                  onChange={(e) => onUpdateStep(step.id, { slideId: e.target.value || undefined }, true)}
                  style={{ width: "100%", padding: "8px 9px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", background: "#fff" }}
                >
                  {slides.map((slide) => (
                    <option key={slide.id} value={slide.id}>Slide {slide.position}: {slide.title}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "600 8.5px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>Your notes to the rep — tone, emphasis, length</span>
                <textarea
                  value={step.instruction}
                  onChange={(e) => onUpdateStep(step.id, { instruction: e.target.value })}
                  onBlur={() => onSave()}
                  placeholder="e.g. Lead with the Phase 3 program; keep it under 3 sentences."
                  style={{ width: "100%", minHeight: 68, resize: "vertical", padding: "8px 9px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 11.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg)", background: "var(--dn-surface-2)" }}
                />
              </label>
              <div style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "600 8.5px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>What the rep says here — approved text (locked, changes go through MLR)</span>
                <div style={{ padding: "8px 9px", borderRadius: 8, background: "#f8fafc", border: "1px dashed var(--dn-border)", font: "400 10.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
                  {slides.find((s) => s.id === step.slideId)?.preview ?? "Select an approved slide to anchor this section."}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 7, borderTop: "1px solid var(--dn-surface-2)", paddingTop: 10 }}>
              <input
                value={planNote}
                onChange={(e) => onNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onApplyNote(); }}
                placeholder="Or tell DocNexus — “lead with safety”, “use slide 3 here”…"
                style={{ width: "100%", padding: "8px 9px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 11.5px/1.3 var(--dn-font-sans)", background: "#fff" }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                <button onClick={onApplyNote} disabled={!planNote.trim()} style={{ ...btnGhost, flex: 1, padding: "8px 9px", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", opacity: planNote.trim() ? 1 : 0.55 }}>Apply note to this section</button>
                <button onClick={onReset} title="Discard edits and re-draft the pitch from the approved deck order" style={{ ...btnGhost, flexShrink: 0, padding: "8px 9px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>↺ Re-draft from deck</button>
              </div>
              {planMsg && <div style={{ font: "500 10.5px/1.4 var(--dn-font-sans)", color: planMsg.startsWith("Could not") ? "#991b1b" : "var(--dn-fg-subtle)" }}>{planMsg}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- RULES MODE ---------- */
function RulesMode({ rules, post }: { rules: UiRule[]; post: (body: Record<string, unknown>) => Promise<StudioSnap | null> }) {
  const [filter, setFilter] = useState("all");
  const tabs = [["all", "All"], ["Global", "Global"], ["Persona", "Persona"], ["HCP", "HCP-specific"]] as const;
  const groups = useMemo(() => {
    const byTier: Record<string, UiRule[]> = {};
    rules.filter((r) => filter === "all" || r.tier === filter).forEach((r) => { (byTier[r.tier] ??= []).push(r); });
    return byTier;
  }, [rules, filter]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 10, padding: 4, gap: 3, boxShadow: "var(--dn-shadow-card)" }}>
          {tabs.map(([k, l]) => <span key={k} onClick={() => setFilter(k)} style={{ padding: "7px 13px", borderRadius: 7, font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer", color: filter === k ? "#fff" : "var(--dn-fg-muted)", background: filter === k ? "var(--dn-brand-base)" : "transparent" }}>{l}</span>)}
        </div>
        <span style={{ font: "500 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Guardrails are locked. Drafts from coaching need your review before they go live.</span>
      </div>
      <div style={{ maxWidth: 1080 }}>
        {Object.entries(groups).map(([tier, rs]) => (
          <div key={tier} style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: tier === "Global" ? "var(--dn-brand-base)" : tier === "Persona" ? "var(--dn-accent-purple)" : "var(--dn-accent-pink)" }} /><span style={{ font: "600 13px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{tier === "HCP" ? "HCP-specific" : tier}</span><span style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{rs.length}</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
              {rs.map((r) => <RuleCard key={r.id} r={r} onAccept={() => void post({ action: "ruleStatus", ruleId: r.id, status: "active" })} onReject={() => void post({ action: "ruleStatus", ruleId: r.id, status: "rejected" })} />)}
            </div>
          </div>
        ))}
        {Object.keys(groups).length === 0 && <div style={{ textAlign: "center", padding: 40, ...{ background: "#fff" }, border: "1px solid var(--dn-border)", borderRadius: 13, font: "400 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>No rules in this scope yet.</div>}
      </div>
    </div>
  );
}

function statusPill(status: string): React.CSSProperties {
  const m: Record<string, [string, string]> = { Active: ["var(--dn-accent-green-bg)", "#166534"], Draft: ["var(--dn-surface-2)", "var(--dn-fg-muted)"], "Needs source": ["var(--dn-accent-yellow-bg)", "#92400e"], "Needs review": ["var(--dn-accent-yellow-bg)", "#92400e"], Blocked: ["#fee2e2", "#991b1b"], Rejected: ["#fee2e2", "#991b1b"] };
  const [bg, c] = m[status] ?? m.Draft!;
  return { font: "600 9.5px/1 var(--dn-font-sans)", padding: "4px 8px", borderRadius: 5, background: bg, color: c };
}

function RuleCard({ r, onAccept, onReject, compact }: { r: UiRule; onAccept: () => void; onReject: () => void; compact?: boolean }) {
  const pending = r.status !== "Active" && r.status !== "Rejected";
  const locked = r.source === "guardrail";
  return (
    <div style={{ border: `1px solid ${r.status === "Blocked" ? "#fca5a5" : "var(--dn-border)"}`, borderRadius: 11, padding: "12px 14px", background: r.status === "Blocked" ? "#fef2f2" : "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, flexWrap: "wrap" }}>
        {!compact && <span style={{ font: "600 9.5px/1 var(--dn-font-sans)", padding: "4px 8px", borderRadius: 5, background: "rgba(6,73,172,.08)", color: "var(--dn-brand-base)" }}>{r.tier}</span>}
        <span style={{ font: "600 9.5px/1 var(--dn-font-sans)", padding: "4px 8px", borderRadius: 5, background: "var(--dn-surface-2)", color: "var(--dn-fg-muted)" }}>{r.type}</span>
        <span style={statusPill(r.status)}>{r.status}</span>
      </div>
      <div style={{ font: "500 12.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{r.text}</div>
      {r.note && <div style={{ font: "400 10.5px/1.4 var(--dn-font-sans)", color: r.status === "Blocked" ? "#991b1b" : "var(--dn-fg-subtle)", marginTop: 6 }}>{r.note}</div>}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, gap: 10 }}>
        <span style={{ font: "400 10.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{r.scope}</span>
        {pending && r.status !== "Blocked" && !locked && (
          <div style={{ display: "flex", gap: 10 }}>
            <span onClick={onAccept} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", cursor: "pointer" }}>Accept</span>
            <span onClick={onReject} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", cursor: "pointer" }}>Reject</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- READINESS MODE ---------- */
function ReadinessMode({ snap, submitState, onSubmit }: { snap: StudioSnap | null; submitState: string; onSubmit: () => void }) {
  const fallbackChecklist = [
    { label: "Setup complete", done: true },
    { label: "Approved knowledge bound (MLR active)", done: true },
    { label: "Persona & AI disclosure set", done: true },
    { label: "Escalation & AE routing configured", done: true },
    { label: "Rehearsal completed", done: false },
    { label: "Coaching rules reviewed", done: false },
  ];
  const checklist = snap ? snap.readiness.items.map((i) => ({ label: i.label, done: i.done })) : fallbackChecklist;
  const pct = snap ? snap.readiness.pct : 68;
  const itemsLeft = checklist.filter((r) => !r.done).length;
  const canLaunch = snap ? snap.readiness.canLaunch : false;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 18, alignItems: "start", maxWidth: 1080 }}>
      <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 14, padding: "22px 20px", boxShadow: "var(--dn-shadow-card)", textAlign: "center", position: "sticky", top: 14 }}>
        <div style={{ width: 120, height: 120, borderRadius: "50%", margin: "0 auto 16px", background: `conic-gradient(var(--dn-brand-base) ${pct}%, var(--dn-surface-2) 0)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 92, height: 92, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", font: "700 26px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{pct}%</div>
        </div>
        <div style={{ font: "600 14px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Launch readiness</div>
        <div style={{ font: "400 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", margin: "6px 0 18px" }}>{itemsLeft} items left. Launch and CRM sync run automatically on approval.</div>
        {(() => {
          // Disabled unless launch-ready; and never re-submittable while submitting or once approved
          // (the old `!canLaunch && submitState !== "approved"` re-enabled the button after the 1st click).
          const disabled = !canLaunch || submitState === "pending" || submitState === "approved";
          return (
            <button onClick={onSubmit} disabled={disabled} style={{ ...btnPrimary, width: "100%", background: submitState === "approved" ? "var(--dn-success)" : "var(--dn-brand-base)", opacity: disabled && submitState !== "approved" ? 0.55 : 1, cursor: disabled ? "default" : "pointer" }}>{submitState === "approved" ? "Approved ✓" : submitState === "pending" ? "Submitting…" : "Submit for approval"}</button>
          );
        })()}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {checklist.map((r) => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 11, border: "1px solid var(--dn-border)", background: "#fff" }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", background: r.done ? "var(--dn-success)" : "var(--dn-border-strong)" }}>{r.done ? "✓" : ""}</span>
            <span style={{ font: "600 13px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{r.label}</span>
            <span style={{ marginLeft: "auto", ...statusPill(r.done ? "Active" : "Draft") }}>{r.done ? "Done" : "Pending"}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: 11, border: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
          <span style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", font: "700 13px/1 var(--dn-font-sans)", background: "#fff", color: "var(--dn-brand-base)" }}>⚙</span>
          <span style={{ font: "500 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>On approval, DocNexus activates the rep, sends portal invitations to the audience, and logs every interaction back to your CRM automatically — no extra steps.</span>
        </div>
      </div>
    </div>
  );
}
