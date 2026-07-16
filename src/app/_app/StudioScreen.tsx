"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { AppState } from "./NexusRepApp";
import { btnGhost, btnPrimary } from "./NexusRepApp";
import { streamArena } from "@lib/arena-client";
import { DEFAULT_RULES, KNOWLEDGE_ASSETS, TRAIN_SEED_KEY, setupTopicsFor, firstSetupGapIndex } from "./data";
import { isOverviewPrompt } from "./overviewPrompt";
import { SlideView } from "../_components/SlideView";
import { VideoAgentStage, type VideoAgentStageHandle } from "../_components/VideoAgentStage";
import { StudioAgentMode } from "./StudioAgentMode";
import { OpenAiVoiceProvider, createRecognizer, setSpeechLanguage, toneSpeechOpts, estimateSpeechMs, type ClientRecognizer } from "@lib/browser-speech";
import { correctHcpAsrBestAlternative } from "@lib/asr-correct";
import { useCuedSlide } from "../_components/useCuedSlide";
import { invalidateBrandCache, useBrand } from "../_components/useBrand";
import type { SetupProposedAction } from "@modules/setupAssistant";

type StudioMode = "setup" | "agent" | "pitch" | "train" | "rules" | "readiness";
const MODES: { key: StudioMode; label: string }[] = [
  { key: "setup", label: "Build" },
  { key: "agent", label: "Agent" },
  { key: "pitch", label: "Pitch & Script" },
  { key: "train", label: "Training" },
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
  rep: { displayName: string; state: string; voiceStyle?: string };
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

/* UI SETUP_TOPICS key → server questionKey (persists a scripted answer to the right field) */
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
          {mode === "setup" ? "Answer DocNexus's questions on the left — it drafts each section on the right." : mode === "agent" ? "Pick who your rep is on video — face and voice. Browse the gallery or train your own from footage." : mode === "pitch" ? "Pick the deck, perfect the slide-by-slide script. Coach any line — approved text changes go through MLR." : mode === "train" ? "Practice from scratch or clone a real session, coach the answers, and turn accepted feedback into rules." : mode === "rules" ? "Locked guardrails + the rules your coaching creates." : "Resolve the checklist, then submit for approval."}
        </span>
      </div>

      {mode === "setup" && <BuildMode repName={repName} snap={snap} post={post} app={app} refresh={refresh} />}
      {mode === "agent" && <StudioAgentMode />}
      {mode === "pitch" && <PitchMode voiceStyle={snap?.rep.voiceStyle} />}
      {mode === "train" && <TrainMode rules={rules} post={post} repName={repName} app={app} voiceStyle={snap?.rep.voiceStyle} />}
      {mode === "rules" && <RulesMode rules={rules} post={post} />}
      {mode === "readiness" && <ReadinessMode snap={snap} submitState={submitState} onSubmit={submit} />}
    </div>
  );
}

/* ---------- BUILD MODE ---------- */
function BuildMode({ repName, snap, post, app, refresh }: { repName: string; snap: StudioSnap | null; post: (body: Record<string, unknown>) => Promise<StudioSnap | null>; app: AppState; refresh: () => Promise<void> }) {
  const brand = useBrand();
  const [step, setStep] = useState(0);
  const [chat, setChat] = useState<{ role: "assistant" | "user"; text: string }[]>([]);
  const [proposed, setProposed] = useState<SetupProposedAction[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [input, setInput] = useState("");
  // True once a document autofilled setup: from then on the guided script SKIPS questions the doc
  // already answered and only asks the gaps (before an upload it advances linearly, one at a time).
  const [docAutofilled, setDocAutofilled] = useState(false);
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
  async function onUpload(file: File | undefined): Promise<{ blocks: number; safety: number; filled: string[] } | null> {
    if (!file) return null;
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
        return { blocks: d.parsed.blocks, safety: safetyCount, filled };
      }
      setUploadMsg(`Couldn't parse: ${d.error ?? res.status}`);
      return null;
    } catch (e) {
      setUploadMsg(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
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
  // Load ISI status on mount so the assistant can flag a missing/critical safety statement even
  // before an upload happens this session.
  useEffect(() => { void loadSafety(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (action === "approve") void nudgeOutstanding(step); // ISI in place — nudge toward whatever's left
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

  // The setup question keys that already have a value on the server (from a document autofill or a
  // prior answer). Used to SKIP questions a document already covered so only the gaps get asked.
  const answeredServerKeys = new Set(
    (snap?.sections ?? []).flatMap((s) => s.fields.filter((f) => (f.value ?? "").trim()).map((f) => f.key)),
  );
  const nextUnansweredFrom = (from: number) => firstSetupGapIndex(topics, ANSWER_KEY, answeredServerKeys, from);
  // After a document autofill the script jumps over already-answered questions; before one, it walks
  // linearly (so a fresh, unassisted setup still goes one question at a time).
  const nextStepFrom = (from: number) => (docAutofilled ? nextUnansweredFrom(from) : from);

  // Seed the guided script ONCE: greeting + first question. The scripted Q&A is the backbone the
  // brand user follows; typed instructions are layered on top (see submitInput / sendChat).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !topics.length) return;
    seededRef.current = true;
    setChat([
      { role: "assistant", text: "I’ll set up your AI rep — answer a few quick questions and I’ll draft each section on the right. You can also just tell me what you want at any point (“focus it on atrial fibrillation”, “never discuss dosing”) or upload a document and I’ll fill it in." },
      { role: "assistant", text: topics[0]!.q },
    ]);
  }, [topics]);

  // Answer the CURRENT scripted question (chip click, or a plain typed answer): record it in the
  // chat, persist it, and advance the guided script to the next question — instant, no round-trip.
  const answerScripted = (value: string) => {
    const t = topics[step];
    if (!t) return;
    setInput("");
    const qk = ANSWER_KEY[t.key];
    if (qk) void post({ action: "answer", questionKey: qk, value });
    setStatus((s) => (s[t.section] === "confirmed" ? s : { ...s, [t.section]: "drafted" }));
    const next = nextStepFrom(step + 1);
    setStep(next);
    setOpen(topics[next]?.section ?? t.section);
    setChat((c) => [
      ...c,
      { role: "user" as const, text: value },
      ...(topics[next] ? [{ role: "assistant" as const, text: topics[next]!.q }] : []),
    ]);
    if (!topics[next]) void nudgeOutstanding(next); // last question answered → drive to fully done
  };

  // "Decide for me": draft every section with sensible defaults (first chip each), skip to the end.
  const autoFill = () => {
    topics.forEach((t) => {
      const qk = ANSWER_KEY[t.key];
      if (qk) void post({ action: "answer", questionKey: qk, value: t.chips[0]![1] });
    });
    setStatus((s) => {
      const n = { ...s };
      topics.forEach((t) => { if (n[t.section] !== "confirmed") n[t.section] = "drafted"; });
      return n;
    });
    setStep(topics.length);
    setChat((c) => [...c, { role: "assistant", text: "Done — I drafted every section with sensible defaults." }]);
    void nudgeOutstanding(topics.length); // then point at whatever still needs confirming
  };

  // Skip an optional question, advancing the guided script (and driving to done if it was the last).
  const skipStep = () => {
    const next = nextStepFrom(step + 1);
    setStep(next);
    setOpen(topics[next]?.section ?? null);
    if (topics[next]) setChat((c) => [...c, { role: "assistant", text: topics[next]!.q }]);
    else void nudgeOutstanding(next);
  };

  // "Autofill from a document" upload: extract + fill, report what landed, then RESUME the guided
  // script at the first field the document DIDN'T cover — so a partial extraction (say 14 values
  // with a couple of gaps in the middle) gets those gaps asked back instead of silently left blank.
  const onUploadAndResume = async (file: File | undefined) => {
    if (!file) return;
    const r = await onUpload(file);
    if (!r) return;
    setDocAutofilled(true);
    const filledList = r.filled.length ? ` I filled ${r.filled.map((f) => f.replace(/_/g, " ")).join(", ")}.` : "";
    const lead = `Pulled ${r.blocks} passage${r.blocks === 1 ? "" : "s"}${r.safety ? ` and ${r.safety} ISI statement${r.safety === 1 ? "" : "s"}` : ""} from “${file.name}” for MLR review.${filledList}`;
    // Recompute what's still blank from the fresh snapshot, then jump the script to the first gap.
    let sections = snap?.sections ?? [];
    try { const res = await fetch("/api/studio"); if (res.ok) { const s = (await res.json()) as StudioSnap | null; if (s) sections = s.sections; } } catch { /* fall back to current snap */ }
    const filled = new Set(sections.flatMap((sec) => sec.fields.filter((f) => (f.value ?? "").trim()).map((f) => f.key)));
    const gap = firstSetupGapIndex(topics, ANSWER_KEY, filled);
    if (gap >= topics.length) {
      setStep(topics.length);
      setChat((c) => [...c, { role: "assistant", text: lead }]);
      void nudgeOutstanding(topics.length);
    } else {
      setStep(gap);
      setOpen(topics[gap]!.section);
      setChat((c) => [...c, { role: "assistant", text: `${lead} A few things it didn’t cover — let’s fill those in. ${topics[gap]!.q}` }]);
    }
  };

  // A typed message is an INSTRUCTION/question (→ agent) rather than a plain answer to the current
  // question when it reads like a command or a question, or is long. Otherwise it's the scripted
  // answer, so the guided flow stays snappy. Chips are always the unambiguous quick path.
  const INSTRUCTION_RE = /\?\s*$|^\s*(use|ingest|upload|add|set|change|rename|focus|make|never|don'?t|do not|always|remove|delete|drop|show|what|how|why|when|who|which|can you|could you|please|turn|enable|disable|draft|create|also|update|switch|target|block|avoid|include|exclude|tell me|give me)\b/i;
  const looksLikeInstruction = (t: string) => INSTRUCTION_RE.test(t) || t.split(/\s+/).length > 12;
  const submitInput = () => {
    const t = input.trim();
    if (!t) return;
    if (step < topics.length && !looksLikeInstruction(t)) answerScripted(t);
    else void sendChat(t);
  };

  // Free-form instruction/question → the agentic assistant. It replies and PROPOSES actions
  // (confirm chips); nothing changes until the user confirms. Works mid-script or after it.
  async function sendChat(message: string) {
    const text = message.trim();
    if (!text || chatBusy) return;
    setInput("");
    setChatBusy(true);
    const history = chat.slice(-12);
    setChat((c) => [...c, { role: "user", text }]);
    try {
      const res = await fetch("/api/setup/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      const d = (await res.json()) as { reply?: string; actions?: SetupProposedAction[]; error?: string };
      setChat((c) => [...c, { role: "assistant", text: res.ok ? (d.reply || "Okay.") : `I couldn't do that: ${d.error ?? res.status}` }]);
      if (res.ok) {
        setProposed(d.actions ?? []);
        // No action to confirm → the detour is done, so drive back to finishing setup.
        if (!(d.actions ?? []).length) void nudgeOutstanding(step);
      }
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setChatBusy(false);
    }
  }

  // Completeness driver: after any turn, keep the setup moving toward FULLY done. If scripted
  // questions remain, re-ask the current one; once they're all answered, surface whatever is still
  // open from the real readiness checklist (sections to confirm, ISI, etc.) until nothing's left.
  // `stepNow` is passed explicitly because setStep is async and the closure's `step` may be stale.
  async function nudgeOutstanding(stepNow: number) {
    if (stepNow < topics.length) {
      setChat((c) => [...c, { role: "assistant", text: `Back to setup — ${topics[stepNow]!.q}` }]);
      return;
    }
    let items = snap?.readiness.items ?? [];
    try {
      const res = await fetch("/api/studio");
      if (res.ok) { const s = (await res.json()) as StudioSnap | null; if (s) items = s.readiness.items; }
    } catch { /* fall back to the current snapshot */ }
    const left = items.filter((i) => !i.done);
    const isiMissing = !safety?.active?.text?.trim();
    if (!left.length && !isiMissing) {
      setChat((c) => [...c, { role: "assistant", text: "That’s everything — the rep is fully set up and ready to review and launch. 🎉" }]);
      return;
    }
    const bullets = left.map((i) => `• ${i.label}${i.blocking ? " (required)" : ""}`);
    if (isiMissing) bullets.push("• Approved ISI in place (required)");
    const focus = isiMissing ? "the approved ISI" : (left.find((i) => i.blocking) ?? left[0])!.label;
    setChat((c) => [...c, { role: "assistant", text: `Before this is fully done, a few things are still open on the right:\n${bullets.slice(0, 5).join("\n")}\n\nLet’s finish ${focus} next.` }]);
  }

  // Execute ONE confirmed action via existing endpoints. If a set_field answers the CURRENT scripted
  // question, advance the guided script too so the two stay in lockstep.
  async function confirmAction(action: SetupProposedAction) {
    setProposed((p) => p.filter((a) => a !== action));
    const say = (text: string) => setChat((c) => [...c, { role: "assistant", text }]);
    try {
      if (action.type === "set_field" && action.fieldKey && action.value) {
        await post({ action: "answer", questionKey: action.fieldKey, value: action.value });
        if (action.fieldKey === "brand") invalidateBrandCache();
        await refresh();
        const cur = topics[step];
        if (cur && ANSWER_KEY[cur.key] === action.fieldKey) {
          setStatus((s) => (s[cur.section] === "confirmed" ? s : { ...s, [cur.section]: "drafted" }));
          const next = step + 1;
          setStep(next);
          setOpen(topics[next]?.section ?? cur.section);
          if (topics[next]) {
            say(`${action.summary ?? "Done"}. ${topics[next]!.q}`);
          } else {
            say(`${action.summary ?? "Done"}.`);
            void nudgeOutstanding(next); // last question just answered → drive to fully done
          }
        } else {
          say(`${action.summary ?? "Updated"}. Fine-tune it in the sections on the right if you like.`);
          void nudgeOutstanding(step);
        }
      } else if (action.type === "draft_rule" && action.ruleFeedback) {
        await post({ action: "rule", feedback: action.ruleFeedback, scope: action.ruleScope ?? "persona" });
        await refresh();
        say("Added that as a conversation rule — you’ll see it under Rules for review.");
        void nudgeOutstanding(step);
      } else if (action.type === "flag_isi") {
        setOpen("knowledge");
        say("Opened Approved knowledge — add or confirm the ISI there. It’s required before the rep can go live.");
      } else {
        // request_upload / ingest_document (no in-chat attachment): point at the upload affordances.
        setOpen("knowledge");
        say("Use “Autofill from a document” below, or “Add source file” under Approved knowledge, and I’ll extract the setup + safety content for MLR review.");
      }
    } catch (e) {
      say(`That didn’t go through: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const confirmSection = async (uiKey: string) => {
    setStatus((s) => ({ ...s, [uiKey]: "confirmed" }));
    setOpen(null);
    const serverKey = SECTION_KEY[uiKey];
    if (serverKey) await post({ action: "section", section: serverKey, status: "complete" });
    // Keep prompting from our side after every bit of progress — until onboarding is fully done.
    void nudgeOutstanding(step);
  };

  // "Ask DocNexus to revise" — reopen the section for re-drafting: mark it needs_input
  // (un-confirmed) so the brand user can re-answer it in the setup chat.
  const reviseSection = (uiKey: string) => {
    setStatus((s) => ({ ...s, [uiKey]: "needs_input" }));
    setOpen(uiKey);
    const serverKey = SECTION_KEY[uiKey];
    if (serverKey) void post({ action: "section", section: serverKey, status: "needs_input" });
  };

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
          <div style={{ lineHeight: 1.3 }}><div style={{ font: "600 13.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>DocNexus Setup Assistant</div></div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {chat.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 9, flexDirection: m.role === "user" ? "row-reverse" : "row" }}>
              {m.role === "assistant" && <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 7, background: "var(--dn-gradient-ai)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11 }}>✦</span>}
              <span style={{ maxWidth: "82%", padding: "9px 12px", borderRadius: 10, font: "400 12px/1.5 var(--dn-font-sans)", whiteSpace: "pre-wrap", background: m.role === "user" ? "var(--dn-brand-base)" : "var(--dn-surface-2)", color: m.role === "user" ? "#fff" : "var(--dn-fg)" }}>{m.text}</span>
            </div>
          ))}
          {chatBusy && <div style={{ paddingLeft: 31, font: "500 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Thinking…</div>}
          {/* Current scripted question — click a suggestion to answer instantly (the glued guided path). */}
          {step < topics.length && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, paddingLeft: 31, marginTop: 2, alignItems: "center" }}>
              {topics[step]!.optional && <span data-testid="setup-optional" style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", background: "var(--dn-surface-2)", padding: "4px 7px", borderRadius: 5 }}>optional</span>}
              {topics[step]!.chips.map((c) => (
                <span key={c[0]} data-testid="setup-chip" onClick={() => answerScripted(c[1])} style={{ padding: "8px 12px", background: "#fff", border: "1px solid var(--dn-brand-light)", borderRadius: 9, font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-brand-base)", cursor: "pointer" }}>{c[0]}</span>
              ))}
              {topics[step]!.optional && (
                <span data-testid="setup-skip" onClick={skipStep} style={{ padding: "8px 12px", border: "1px dashed var(--dn-border)", borderRadius: 9, font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg-muted)", cursor: "pointer" }}>Skip →</span>
              )}
            </div>
          )}
          {/* Proposed actions from a typed instruction — the assistant only PROPOSES; nothing changes until Confirm. */}
          {proposed.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 31 }}>
              {proposed.map((a, i) => (
                <div key={i} data-testid="setup-action" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 11px", background: "#fff", border: "1px solid var(--dn-brand-light)", borderRadius: 10 }}>
                  <span style={{ minWidth: 0, font: "500 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{a.summary}</span>
                  <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button data-testid="setup-action-confirm" onClick={() => void confirmAction(a)} style={{ ...btnPrimary, padding: "6px 11px", font: "600 11px/1 var(--dn-font-sans)" }}>Confirm</button>
                    <button onClick={() => setProposed((p) => p.filter((x) => x !== a))} style={{ ...btnGhost, padding: "6px 9px", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Dismiss</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--dn-border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
            <span style={{ font: "500 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{Math.min(step, topics.length)} of {topics.length} answered</span>
            <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {/* Upload once instead of answering one-by-one: the document fills the blanks. */}
              <label style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }} title="Upload a deck / PI / FAQ — I'll fill the setup answers from it">
                📎 Autofill from a document
                <input data-testid="upload-autofill" type="file" accept=".pptx,.ppt,.pdf,.txt,.md" onChange={(e) => void onUploadAndResume(e.target.files?.[0])} style={{ display: "none" }} />
              </label>
              {step < topics.length && <span onClick={autoFill} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>Decide for me →</span>}
            </span>
          </div>
          {/* Footer surfaces the autofill outcome (or a failure); the full parse/approve detail lives
              in the Approved-knowledge section, not duplicated here. */}
          {(() => {
            const note = uploadMsg.match(/Auto-filled[^]*$/)?.[0] ?? (/^(Couldn't parse|Upload failed|Parsing)/.test(uploadMsg) ? uploadMsg : null);
            return note ? <div style={{ font: "500 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginBottom: 9 }}>{note}</div> : null;
          })()}
          <div style={{ height: 5, borderRadius: 3, background: "var(--dn-surface-2)", overflow: "hidden", marginBottom: 11 }}><div style={{ height: "100%", borderRadius: 3, background: "var(--dn-brand-base)", width: `${(Math.min(step, topics.length) / Math.max(topics.length, 1)) * 100}%` }} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <input data-testid="setup-input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitInput(); }} placeholder="Type an answer, or tell me what to change…" style={{ flex: 1, padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 12px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
            <button data-testid="setup-send" onClick={submitInput} disabled={chatBusy} style={{ ...btnPrimary, padding: "9px 14px", font: "600 12px/1 var(--dn-font-sans)", opacity: chatBusy ? 0.6 : 1 }}>Send</button>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span style={{ font: "600 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", padding: "2px 2px 4px" }}>Open a section to edit, then confirm it.</span>
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
                    <div style={{ font: "400 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 13 }}>MLR approves documents and safety blocks; approved passages become the rep&apos;s live knowledge.</div>
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
                    <div style={{ font: "400 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 8 }}>The launch deck ships pre-approved. Uploads start <strong>In MLR review</strong> — approve or reject each passage in the queue above; rejected documents can be removed.</div>
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
                    <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 13 }}>Required and forbidden talking points the rep must follow — gated by compliance. Most rules are written for you when you coach the rep in Training. Manage the full set, by scope, in Rules.</div>
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
                  <button onClick={() => void confirmSection(sec.key)} style={{ ...btnPrimary, padding: "9px 15px", font: "600 12px/1 var(--dn-font-sans)" }}>Confirm section</button>
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

/** True when the slide chip would just repeat the section label — the auto-drafted pitch
 *  names each section after its slide, so the chip only earns its place when they differ
 *  (a renamed section, or a section re-anchored to another slide). */
function slideChipRedundant(sectionLabel?: string | null, slideTitle?: string | null): boolean {
  if (!slideTitle) return true;
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  return !!sectionLabel && norm(sectionLabel) === norm(slideTitle);
}
interface RepAnswer {
  text: string;
  route: string;
  isi: boolean;
  detailAidSlideId?: string | null;
  sourceIds?: string[];
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
  sourceSessionId?: string;
  sourceTurnIndex?: number;
  sourceHcpName?: string;
  sourceAt?: string | null;
}

interface SessionListRow {
  id: string;
  hcp: string;
  date: string;
  duration: string;
  questions: number | string;
  comp: string;
  compTone: string;
  hasRecording?: boolean;
  followup: string;
}
interface SessionDetailTurn {
  speaker: "hcp" | "rep";
  text: string;
  sourceIds?: string[];
  detailAidSlideId?: string | null;
  at?: string | null;
}
interface SessionDetailSnap {
  session: {
    id: string;
    hcp: string;
    startedAt: string;
    durationSeconds: number;
    questionCount: number;
    complianceStatus: string;
    recordingUrl?: string | null;
  };
  turns: SessionDetailTurn[];
}
interface TrainSeed { q?: string; from?: string; sessionId?: string; mode?: "practice" | "session" }

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

function cloneSessionTurnsForTraining(detail: SessionDetailSnap): Exchange[] {
  const cloned: Exchange[] = [];
  let lastHcp = "";
  detail.turns.forEach((turn, idx) => {
    if (turn.speaker === "hcp") {
      lastHcp = turn.text;
      return;
    }
    const text = turn.text.trim();
    if (!text) return;
    const isOpening = !lastHcp;
    cloned.push({
      q: lastHcp,
      kind: isOpening ? "greeting" : undefined,
      answers: [{
        text,
        route: turn.sourceIds?.length ? "approved_content" : "session_line",
        isi: /\bImportant Safety Information\b/i.test(text),
        detailAidSlideId: turn.detailAidSlideId ?? null,
        sourceIds: turn.sourceIds ?? [],
        usedLlm: true,
      }],
      coachings: [],
      scope: "hcp",
      accepted: false,
      sourceSessionId: detail.session.id,
      sourceTurnIndex: idx,
      sourceHcpName: detail.session.hcp,
      sourceAt: turn.at ?? null,
    });
  });
  return cloned;
}

/** Split a rep answer into its coachable body and the active approved ISI block. */
// The trainer HEARS a recoached line immediately — same browser voice the doctor
// view uses, so coaching judges cadence and tone, not just the words on screen.
let trainerVoice: OpenAiVoiceProvider | null = null;
async function speakCoached(text: string, style?: string, voice?: string): Promise<void> {
  const [body] = splitIsi(text);
  if (!body.trim()) return;
  if (!trainerVoice) {
    trainerVoice = new OpenAiVoiceProvider();
    await trainerVoice.warmup();
  }
  trainerVoice.cancel();
  // OpenAI TTS with the brand's SELECTED voice (Agent tab) + tone. Passing `voice` explicitly is
  // what makes the chosen voice actually propagate instead of silently using the server default.
  void trainerVoice.speak(body, { tone: style, voice, ...toneSpeechOpts(style) });
}

function splitIsi(text: string): [string, string | null] {
  const parts = text.split(/\n\nImportant Safety Information:\s*/);
  return parts.length > 1 ? [parts[0]!.trim(), parts.slice(1).join(" ").trim()] : [text, null];
}

/* ---------- PITCH & SCRIPT — perfect the slide-by-slide script before free-flow training ----------
 * Same skeleton as Train & Preview, but the PPT sits where the video was: pick (or upload) the
 * source deck on the left, the knowledge base drafts the script, the middle column is the script
 * line by line (coach any line in place), and the right column edits sections. Rules live below
 * the deck. Nothing here creates sessions — it is all rehearsal against the compliance graph. */
function PitchMode({ voiceStyle }: { voiceStyle?: string }) {
  const {
    overviewPlan, activePlanStepId, setActivePlanStepId, activePlanSlideId,
    planNote, setPlanNote, planMsg, persistOverviewPlan, updatePlanStep,
    applyPlanNote, movePlanStep, resetOverviewPlan,
  } = useOverviewPlan();

  // ── The script: what the rep actually SAYS, slide by slide (compliance graph, no sessions).
  const [script, setScript] = useState<OverviewSegment[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [scriptMsg, setScriptMsg] = useState("");
  const [lineCoach, setLineCoach] = useState<number | null>(null);
  const [lineNote, setLineNote] = useState("");

  const generate = async (): Promise<OverviewSegment[]> => {
    if (generating) return script ?? [];
    setGenerating(true);
    setScriptMsg("");
    try {
      const res = await fetch("/api/train/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "overview", text: "Can you walk me through the approved information?" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { segments?: OverviewSegment[] };
      setScript(d.segments ?? []);
      return d.segments ?? [];
    } catch (e) {
      setScript([]);
      setScriptMsg(`Couldn't generate the script: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coach ONE line: the note lands on that section's plan instruction (persisted), then the
  // script regenerates so the change is visible immediately.
  const coachLine = async (seg: OverviewSegment, note: string) => {
    const n = note.trim();
    if (!n) return;
    setLineCoach(null);
    setLineNote("");
    await applyPlanNote(n, seg.stepId ?? activePlanStepId);
    const fresh = await generate();
    // Hear the coached line as the rep would deliver it.
    const updated = fresh.find((x) => x.stepId && x.stepId === (seg.stepId ?? activePlanStepId));
    if (updated) void speakCoached(updated.response, voiceStyle);
  };

  // ── Deck sources: which uploaded/approved documents feed the deck + script.
  const [sources, setSources] = useState<{ id: string; title: string; status: string; slides: number }[] | null>(null);
  const loadSources = async () => {
    try {
      const res = await fetch("/api/content/knowledge");
      if (!res.ok) return;
      const d = (await res.json()) as { documents?: { id: string; title: string; status: string; slides?: { id: string }[] }[] };
      setSources((d.documents ?? []).map((doc) => ({ id: doc.id, title: doc.title, status: doc.status, slides: doc.slides?.length ?? 0 })));
    } catch { /* progressive */ }
  };
  useEffect(() => { void loadSources(); }, []);

  const draftFrom = async (assetId?: string) => {
    await resetOverviewPlan(assetId);
    await generate();
  };

  // Upload straight from here — parsed into the MLR queue (Build) like every source.
  const [uploadNote, setUploadNote] = useState("");
  const onUploadDeck = async (file: File | undefined) => {
    if (!file) return;
    setUploadNote(`Parsing "${file.name}"…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const res = await fetch("/api/content/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentBase64: btoa(bin) }),
      });
      const d = (await res.json()) as { parsed?: { blocks: number }; error?: string };
      if (!res.ok || !d.parsed) throw new Error(d.error ?? String(res.status));
      setUploadNote(`Parsed ${d.parsed.blocks} passage(s) from "${file.name}" — approve them in Build → MLR review; the slides join this deck on approval.`);
      void loadSources();
    } catch (e) {
      setUploadNote(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const activeSources = (sources ?? []).filter((d) => d.status === "active" && d.slides > 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 0.85fr", gap: 15, alignItems: "start" }}>
      {/* ── LEFT: the PPT (where Train has the video) + deck sources + rules ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
          <div style={{ padding: "12px 14px 0" }}>
            <div style={{ height: 250, minHeight: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
              <SlideView focusId={activePlanSlideId} compact fill />
            </div>
          </div>
          <div style={{ padding: "9px 14px 12px", font: "400 10.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>The slide for the selected script line — click any line in the middle to jump.</div>
        </div>

        {/* Presentation deck — the ONE deck whose slides are the script's skeleton. Every other
            approved doc (and every slide, this deck's included) is retrieval-only supplement — you
            never "present all sources", so there's a single Draft action per deck, no all-sources one. */}
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "13px 14px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 4 }}>Presentation deck</div>
          <div style={{ font: "400 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 10 }}>The deck you present — its slides are the script&apos;s skeleton. Every other approved document (and all slides) supplements each line automatically from the knowledge base.{activeSources.length > 1 ? " With more than one deck, draft from the one you present; the rest stay as supplementary sources." : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {sources === null && <div style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Loading sources…</div>}
            {activeSources.map((doc) => (
              <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--dn-surface-2)", borderRadius: 9 }}>
                <span style={{ flex: 1, minWidth: 0, font: "600 11px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc.title}</span>
                <span style={{ flexShrink: 0, font: "500 9.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{doc.slides} slide(s)</span>
                <button onClick={() => void draftFrom(doc.id)} style={{ ...btnGhost, flexShrink: 0, padding: "5px 8px", font: "600 9.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{activeSources.length > 1 ? "Present this deck" : "Draft script"}</button>
              </div>
            ))}
            {sources !== null && activeSources.length === 0 && <div style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>No approved sources with slides yet — upload below and approve in Build.</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--dn-surface-2)" }}>
            <label style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>
              ↑ Upload another deck / PDF
              <input data-testid="upload-deck" type="file" accept=".pptx,.ppt,.pdf,.txt,.md" onChange={(e) => void onUploadDeck(e.target.files?.[0])} style={{ display: "none" }} />
            </label>
          </div>
          {uploadNote && <div style={{ font: "500 10px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 8 }}>{uploadNote}</div>}
        </div>

      </div>

      {/* ── MIDDLE: the script, line by line — coach any line in place ── */}
      <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", display: "flex", flexDirection: "column", height: 640 }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Script <span style={{ font: "500 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>· what the rep says, slide by slide</span></span>
          <button onClick={() => void generate()} disabled={generating} style={{ ...btnGhost, padding: "6px 10px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", opacity: generating ? 0.6 : 1 }}>{generating ? "Generating…" : "↻ Regenerate"}</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {script === null && <div style={{ textAlign: "center", color: "var(--dn-fg-subtle)", font: "400 12px/1.6 var(--dn-font-sans)", padding: "40px 14px" }}>Drafting the script from your approved deck…</div>}
          {script !== null && script.length === 0 && <div style={{ textAlign: "center", color: "var(--dn-fg-subtle)", font: "400 12px/1.6 var(--dn-font-sans)", padding: "40px 14px" }}>{scriptMsg || "No approved slides yet — upload a deck on the left and approve it in Build."}</div>}
          {(script ?? []).map((seg, si) => {
            const [body, isiText] = splitIsi(seg.response);
            const active = !!seg.stepId && seg.stepId === activePlanStepId;
            const coachingThis = lineCoach === si;
            return (
              <div
                key={si}
                onClick={() => { if (seg.stepId) setActivePlanStepId(seg.stepId); }}
                style={{ padding: "10px 12px", background: "var(--dn-surface-2)", border: active ? "1px solid var(--dn-brand-base)" : "1px solid var(--dn-border)", boxShadow: active ? "0 0 0 1px var(--dn-brand-base)" : undefined, borderRadius: 9, font: "400 12px/1.55 var(--dn-font-sans)", color: "var(--dn-fg)", cursor: "pointer" }}
              >
                <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-accent-purple)", marginBottom: 5, display: "flex", gap: 6, alignItems: "center" }}>
                  <span>{si + 1}.</span>
                  <span style={{ flex: 1 }}>{seg.stepTitle ?? seg.slideTitle ?? "Approved section"}</span>
                  {!slideChipRedundant(seg.stepTitle ?? seg.slideTitle, seg.slideTitle) && <span style={{ color: "var(--dn-fg-subtle)", textTransform: "none", letterSpacing: 0 }}>▤ {seg.slideTitle}</span>}
                  {seg.stepId && (
                    <span onClick={(e) => { e.stopPropagation(); setLineCoach(coachingThis ? null : si); setLineNote(""); }} style={{ color: "var(--dn-brand-light)", cursor: "pointer", textTransform: "none", letterSpacing: 0 }}>✎ Coach</span>
                  )}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{body}</div>
                {isiText && (
                  <div style={{ marginTop: 9, paddingTop: 8, borderTop: "1px dashed var(--dn-border)", font: "400 10px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
                    <span style={{ fontWeight: 600, letterSpacing: ".02em" }}>Required safety information · active approved block — </span>{isiText}
                  </div>
                )}
                {coachingThis && (
                  <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <input
                      autoFocus
                      value={lineNote}
                      onChange={(e) => setLineNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && lineNote.trim()) void coachLine(seg, lineNote); }}
                      placeholder={`Coach line ${si + 1} — shorter, warmer, use a different slide…`}
                      style={{ flex: 1, padding: "7px 9px", border: "1px solid var(--dn-brand-light)", borderRadius: 7, font: "400 11.5px/1.3 var(--dn-font-sans)", background: "#fff" }}
                    />
                    <button onClick={() => void coachLine(seg, lineNote)} disabled={!lineNote.trim() || generating} style={{ ...btnPrimary, padding: "7px 10px", font: "600 10.5px/1 var(--dn-font-sans)", opacity: lineNote.trim() && !generating ? 1 : 0.55 }}>Apply</button>
                  </div>
                )}
              </div>
            );
          })}
          {scriptMsg && script !== null && script.length > 0 && <div style={{ font: "500 10.5px/1.4 var(--dn-font-sans)", color: "#991b1b" }}>{scriptMsg}</div>}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--dn-border)", font: "400 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
          Coaching a line saves straight into the script — no approval step. Locked medical text is separate: <strong>View approved source</strong> on the right to check it or propose an MLR revision.
        </div>
      </div>

      {/* ── RIGHT: the section editor (big deck already on the left, so no mini slide here) ── */}
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
          onApplyNote={() => void applyPlanNote().then(() => generate())}
          onReset={() => void draftFrom()}
          onNote={setPlanNote}
          onRehearse={() => void generate()}
          rehearsing={generating}
          onMove={movePlanStep}
          showSlide={false}
          rehearseLabel="↻ Regenerate script"
        />
      </div>
    </div>
  );
}

/** Shared pitch-plan state + CRUD (load/save/apply-note/reorder/reset). Used by the
 *  Pitch & Script editor AND Train & Preview (per-line coaching, deck follow) so the two
 *  surfaces can never drift — both read and write the same server-side plan. */
function useOverviewPlan() {
  const [overviewPlan, setOverviewPlan] = useState<OverviewPlanSnap | null>(null);
  const [activePlanStepId, setActivePlanStepId] = useState("");
  const [planNote, setPlanNote] = useState("");
  const [planMsg, setPlanMsg] = useState("");
  const [planSaving, setPlanSaving] = useState(false);

  const loadOverviewPlan = async () => {
    try {
      const res = await fetch("/api/presentation/plan");
      if (!res.ok) return;
      const data = (await res.json()) as OverviewPlanSnap;
      setOverviewPlan(data);
      setActivePlanStepId((current) => current || data.plan.steps[0]?.id || "");
    } catch {
      /* deck editor is progressive; coaching still works without it */
    }
  };

  useEffect(() => {
    void loadOverviewPlan();

  }, []);

  const persistOverviewPlan = async (plan = overviewPlan?.plan, message = "Script saved.") => {
    if (!plan) return;
    setPlanSaving(true);
    setPlanMsg("Saving script…");
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
    if (save) void persistOverviewPlan(nextPlan, "Script section saved.");
  };

  const applyPlanNote = async (feedback = planNote, stepId = activePlanStepId) => {
    const note = feedback.trim();
    if (!note) return;
    setPlanMsg("Applying your note to the script…");
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
      setPlanMsg(data.warning ? `⚠ ${data.warning}` : "Script updated — rehearsals and every doctor conversation use it.");
    } catch (e) {
      setPlanMsg(`Could not apply note: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Reorder script sections — guarded while a save is in flight: two rapid moves could
  // otherwise interleave and the first server response would briefly clobber the second.
  const movePlanStep = (stepId: string, dir: -1 | 1) => {
    if (!overviewPlan || planSaving) return;
    const steps = [...overviewPlan.plan.steps];
    const i = steps.findIndex((st) => st.id === stepId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    const nextPlan = { ...overviewPlan.plan, steps };
    setOverviewPlan({ ...overviewPlan, plan: nextPlan });
    void persistOverviewPlan(nextPlan, "Script order updated — the rep now presents in this order.");
  };

  /** Re-draft the script from the approved deck — optionally from ONE source document. */
  const resetOverviewPlan = async (assetId?: string) => {
    setPlanMsg(assetId ? "Drafting the script from that source…" : "Re-drafting from the full approved deck…");
    try {
      const res = await fetch("/api/presentation/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset", ...(assetId ? { assetId } : {}) }) });
      const data = (await res.json()) as OverviewPlanSnap & { error?: string };
      if (!res.ok) throw new Error(data.error ?? String(res.status));
      setOverviewPlan(data);
      setActivePlanStepId(data.plan.steps[0]?.id || "");
      setPlanMsg(assetId ? "Script drafted from the selected source." : "Reset to approved deck order.");
    } catch (e) {
      setPlanMsg(`Could not draft: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const activePlanStep = overviewPlan?.plan.steps.find((s) => s.id === activePlanStepId) ?? overviewPlan?.plan.steps[0];
  const activePlanSlideId = activePlanStep?.slideId ?? overviewPlan?.slides[0]?.id;

  return {
    overviewPlan, activePlanStepId, setActivePlanStepId, activePlanSlideId,
    planNote, setPlanNote, planMsg, planSaving,
    loadOverviewPlan, persistOverviewPlan, updatePlanStep, applyPlanNote, movePlanStep, resetOverviewPlan,
  };
}

function TrainMode({ rules, post, repName, app, voiceStyle }: { rules: UiRule[]; post: (body: Record<string, unknown>) => Promise<StudioSnap | null>; repName: string; app: AppState; voiceStyle?: string }) {
  const brand = useBrand();
  // Rehydrate the coaching thread from localStorage so it survives tab switches / reload.
  const [exchanges, setExchanges] = useState<Exchange[]>(() => loadTrainState().exchanges ?? []);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [coachDraft, setCoachDraft] = useState<Record<number, string>>(() => loadTrainState().coachDraft ?? {});
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [trainMode, setTrainMode] = useState<"practice" | "session" | "lab">("practice");
  const [sessionRows, setSessionRows] = useState<SessionListRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedCoachSessionId, setSelectedCoachSessionId] = useState("");
  const [loadedCoachSessionId, setLoadedCoachSessionId] = useState<string | null>(null);
  const [sessionCoachMsg, setSessionCoachMsg] = useState("");
  const videoRef = useRef<VideoAgentStageHandle | null>(null);
  // Talk to the rep to rehearse, exactly like a doctor would — same browser ASR the HCP view uses.
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const recRef = useRef<ClientRecognizer | null>(null);
  const [previewSessionId, setPreviewSessionId] = useState(() => loadTrainState().previewSessionId ?? makePreviewSessionId());
  // Shared script plan (per-line coaching writes to it; the deck panel follows the convo).
  const {
    activePlanStepId,
    setActivePlanStepId,
    activePlanSlideId,
    applyPlanNote,
  } = useOverviewPlan();
  const [followSlideId, setFollowSlideId] = useState<string | null>(null);
  // Detail-aid slide switching timed to WHEN the rep speaks the cue — the SAME hook the doctor
  // preview uses. On video the timer anchors to the replica's audio-start (onRepAudioStart →
  // VideoAgentStage), then counts the cue offset; off-video it anchors to the TTS start.
  const { cueSlide, onRepAudioStart } = useCuedSlide(setFollowSlideId);
  const [deckOpen, setDeckOpen] = useState(true);
  // Inline per-section coaching on a rehearsed pitch segment ({exchange, segment} being coached).
  const [segCoach, setSegCoach] = useState<{ exIdx: number; segIdx: number } | null>(null);
  const [segNote, setSegNote] = useState("");
  // Coach menu is COLLAPSED per exchange by default — the thread stays a clean read of answers, and
  // the full coach controls (notes + scope + accept) open only when you click to coach that line.
  const [coachOpen, setCoachOpen] = useState<Record<number, boolean>>({});
  // If push-to-talk finalizes while the previous preview answer is still composing, do not drop the
  // question. Queue it and run it as soon as the current preview settles.
  const pendingAskRef = useRef<string[]>([]);
  // Keep the coaching thread pinned to the newest message (new questions, re-answers,
  // seeded session-coaching handoffs) — no manual scrolling to find the latest.
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [exchanges, busyIdx]);

  // Browser ASR for voice rehearsal (created once; supported() gates the mic button).
  useEffect(() => {
    const rec = createRecognizer();
    recRef.current = rec;
    setMicSupported(rec.supported());
    return () => { try { rec.stop(); } catch { /* already stopped */ } };
  }, []);
  // ASR/TTS locale follows the brand persona's language, set at start() time so a late brand load isn't stale.
  useEffect(() => { setSpeechLanguage(brand?.language); }, [brand?.language]);

  const coachingRules = rules.filter((r) => r.source === "feedback");

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

  // Rehearse the rep with the coaching so far applied. A greeting exchange rewrites the opening
  // line (keeping the mandatory disclosures); any other rewrites the answer. Rehearsal only — the
  // preview endpoint creates no session, logs no turn, enqueues no follow-up.
  const runPreview = async (ex: { kind?: "greeting" | "overview"; q: string; current: string }, coaching: string[]): Promise<RepAnswer> => {
    try {
      const body = ex.kind === "greeting" ? { kind: "greeting", current: ex.current, coaching } : { kind: ex.kind, text: ex.q, coaching, previewSessionId };
      const res = await fetch("/api/train/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        const d = (await res.json()) as { response?: string; route?: string; isiDelivered?: boolean; detailAidSlideId?: string | null; sourceIds?: string[]; usedLlm?: boolean; segments?: OverviewSegment[] };
        return { text: d.response ?? "", route: d.route ?? "", isi: !!d.isiDelivered, detailAidSlideId: d.detailAidSlideId ?? null, sourceIds: d.sourceIds ?? [], usedLlm: !!d.usedLlm, ...(d.segments?.length ? { segments: d.segments } : {}) };
      }
    } catch {
      /* fall through */
    }
    // Honest failure: never show a canned fixture answer as if the rep said it (the fixture
    // is themed to the seeded brand and would be wrong for a re-branded rep anyway).
    return { text: "The rehearsal service is unreachable right now — check the server and try again.", route: "error", isi: false, detailAidSlideId: null, usedLlm: false };
  };

  // Speak an answer through the Tavus REP when the video is on (every answer, asked or coached, is
  // spoken by the replica) — otherwise OpenAI TTS. Never the browser voice as the intended path; it
  // only falls back to TTS if the video rep isn't connected yet.
  const speakAnswer = (text: string) => {
    if (!text) return;
    if (showVideo && videoRef.current?.speak(text)) return;
    void speakCoached(text, voiceStyle, brand?.voiceId || undefined);
  };

  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  const ask = async (forced?: string) => {
    const q = forced?.trim() || input.trim() || brand?.tryQuestions[0] || "Tell me about this therapy.";
    if (asking) {
      const last = pendingAskRef.current[pendingAskRef.current.length - 1];
      if (q && q !== last) pendingAskRef.current.push(q);
      setInput("");
      return;
    }
    const kind = isOverviewPrompt(q, { productTerms: brand?.productTerms ?? [] }) ? "overview" : undefined;
    setAsking(true);
    setInput("");
    try {
      const a = await runPreview({ kind, q, current: "" }, []);
      setExchanges((xs) => [...xs, { q, kind, answers: [a], coachings: [], scope: "persona", accepted: false }]);
      // Deliver exactly like the doctor preview: WALK an overview segment-by-segment (each segment's
      // slide is cued as the rep reaches it), else cue the single answer's slide. Backend gates the
      // slide on a spoken cue, so no cue → no switch. The error fallback is never read aloud.
      if (a.route !== "error") {
        if (a.segments?.length) {
          for (const seg of a.segments) {
            cueSlide(seg.detailAidSlideId, seg.response, showVideo);
            speakAnswer(seg.response);
            await wait(estimateSpeechMs(seg.response));
          }
        } else {
          cueSlide(a.detailAidSlideId, a.text, showVideo);
          speakAnswer(a.text);
        }
      }
    } finally {
      setAsking(false);
      const next = pendingAskRef.current.shift();
      if (next) window.setTimeout(() => void ask(next), 0);
    }
  };

  // Push-to-talk rehearsal: tap the mic, speak a question, the recognized text drives ask().
  const toggleMic = () => {
    const rec = recRef.current;
    if (!rec || !rec.supported()) return;
    if (listening) { rec.stop(); setListening(false); return; }
    trainerVoice?.cancel(); // barge-in: stop the rep speaking before we listen
    setListening(true);
    // Snap mis-heard drug/program names to their canonical spelling — the SAME correction the doctor
    // view applies. Without it the browser ASR sent "Lebrixia stock" straight to the rep (wrong
    // transcript AND, sometimes, the wrong answer).
    rec.start(
      (text, alts) => {
        setListening(false); setInput("");
        const { text: corrected } = correctHcpAsrBestAlternative(alts?.length ? alts : [text], brand?.hotwords ?? [], brand?.productTerms ?? []);
        void ask(corrected || text);
      },
      () => setListening(false),
    );
  };

  const loadSessionRows = async () => {
    if (sessionsLoading) return;
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { rows?: SessionListRow[] };
      const rows = data.rows ?? [];
      setSessionRows(rows);
      if (!selectedCoachSessionId && rows[0]) setSelectedCoachSessionId(String(rows[0].id));
    } catch (e) {
      setSessionCoachMsg(`Couldn't load sessions: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    if (trainMode === "session" && sessionRows.length === 0) void loadSessionRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainMode]);

  const cloneSessionForCoaching = async (sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    setSessionCoachMsg("Cloning the session into Training…");
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      const detail = (await res.json()) as SessionDetailSnap & { error?: string };
      if (!res.ok) throw new Error(detail.error ?? String(res.status));
      const cloned = cloneSessionTurnsForTraining(detail);
      if (!cloned.length) {
        setExchanges([]);
        setCoachDraft({});
        setCoachOpen({});
        setLoadedCoachSessionId(null);
        setSessionCoachMsg("That session has no rep turns to coach yet.");
        return;
      }
      setExchanges(cloned);
      setCoachDraft({});
      setCoachOpen({});
      setPreviewSessionId(makePreviewSessionId());
      setLoadedCoachSessionId(detail.session.id);
      setSelectedCoachSessionId(detail.session.id);
      setFollowSlideId(cloned.find((ex) => ex.answers[0]?.detailAidSlideId)?.answers[0]?.detailAidSlideId ?? null);
      setSessionCoachMsg(`Cloned ${cloned.length} rep line(s) from ${detail.session.hcp}. Coach any line, then Accept to save rule(s).`);
    } catch (e) {
      setSessionCoachMsg(`Couldn't clone session: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Sessions → Training: clone the WHOLE session into the coach thread. A stale one-question seed
  // from older builds still works, but new handoffs always pass a session id.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TRAIN_SEED_KEY);
      if (!raw) return;
      window.localStorage.removeItem(TRAIN_SEED_KEY);
      const seed = JSON.parse(raw) as TrainSeed;
      const sessionId = seed.sessionId ?? seed.from;
      if (seed.mode === "session" || sessionId) {
        setTrainMode("session");
        if (sessionId) {
          setSelectedCoachSessionId(sessionId);
          void cloneSessionForCoaching(sessionId);
        }
        return;
      }
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
    cueSlide(a.segments?.length ? a.segments[a.segments.length - 1]!.detailAidSlideId : a.detailAidSlideId, a.text, showVideo);
    setCoachDraft((d) => ({ ...d, [idx]: "" }));
    setBusyIdx(null);
    speakAnswer(a.text); // hear the retake — through the rep on video, else OpenAI TTS
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
      await post({ action: "acceptCoaching", coachings: ex.coachings, question: ex.q, answer: finalAnswer, scope: ex.scope, sourceSessionId: ex.sourceSessionId, sourceTurnIndex: ex.sourceTurnIndex });
    }
    setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, accepted: true, ruleCount: ex.coachings.length } : x)));
  };

  const setScope = (idx: number, s: CoachScope) => setExchanges((xs) => xs.map((x, i) => (i === idx ? { ...x, scope: s } : x)));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 0.85fr", gap: 15, alignItems: "start" }}>
      {/* Rep preview + drive */}
      <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        {showVideo ? (
          <VideoAgentStage ref={videoRef} onClose={() => setShowVideo(false)} onRepAudioStart={onRepAudioStart} />
        ) : (
          <div style={{ position: "relative", borderRadius: 15, overflow: "hidden", aspectRatio: "4/3", background: "radial-gradient(120% 120% at 50% 0%, #15315f 0%, #0a1a33 60%, #060f1f 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", boxShadow: "var(--dn-shadow-dark)" }}>
            <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.4)", padding: "6px 11px", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fbbf24" }} /><span style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "#fff" }}>AI rep · {repName}</span></div>
            <button onClick={() => setShowVideo(true)} title="Watch the live video rep (DocNexus Agent)" style={{ position: "absolute", top: 12, right: 12, background: "rgba(255,255,255,.14)", color: "#fff", border: "1px solid rgba(255,255,255,.3)", borderRadius: 8, padding: "6px 10px", font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer" }}>🎥 Video</button>
            <div style={{ width: 96, height: 96, borderRadius: "50%", background: "linear-gradient(160deg,#2d4f86,#1a3258)", display: "flex", alignItems: "flex-end", justifyContent: "center", overflow: "hidden", boxShadow: "0 0 0 6px rgba(96,165,250,.12)" }}><svg width="68" height="68" viewBox="0 0 24 24" fill="rgba(191,219,254,.9)"><circle cx="12" cy="8" r="4.2" /><path d="M3.5 21c0-4.4 3.8-7.5 8.5-7.5s8.5 3.1 8.5 7.5z" /></svg></div>
            <div style={{ marginTop: 14, font: "600 13.5px/1 var(--dn-font-sans)", color: "rgba(255,255,255,.92)" }}>{repName}</div>
            <div className="rep-eq" data-on={exchanges.length > 0} style={{ marginTop: 12 }}><span /><span /><span /><span /><span /></div>
          </div>
        )}
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "14px 15px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)", marginBottom: 9 }}>Play the provider — ask, then coach</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} placeholder={listening ? "Listening…" : micSupported ? "Ask the rep — type or tap the mic to talk…" : "Ask the rep a question…"} style={{ flex: 1, minWidth: 0, padding: "10px 12px", border: "1px solid var(--dn-border)", borderRadius: 9, font: "400 12.5px/1 var(--dn-font-sans)", background: "var(--dn-surface-2)" }} />
            {micSupported && (
              <button onClick={toggleMic} title={listening ? "Stop listening" : "Talk to the rep"} aria-label={listening ? "Stop listening" : "Talk to the rep"} style={{ ...btnGhost, padding: "10px 12px", minWidth: 68, textAlign: "center", border: listening ? "1px solid var(--dn-danger)" : undefined, color: listening ? "var(--dn-danger)" : "var(--dn-fg-muted)" }}>{listening ? "● Stop" : "🎤"}</button>
            )}
            <button onClick={() => void ask()} disabled={asking} style={{ ...btnPrimary, padding: "10px 14px", minWidth: 58, textAlign: "center" }}>{asking ? "…" : "Ask"}</button>
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
        <div style={{ display: "inline-flex", background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 11, padding: 4, gap: 3, boxShadow: "var(--dn-shadow-card)" }}>
          {([["practice", "Practice"], ["session", "Coach session"], ["lab", "Model lab"]] as const).map(([k, label]) => (
            <span
              key={k}
              onClick={() => setTrainMode(k)}
              style={{ flex: 1, textAlign: "center", padding: "8px 9px", borderRadius: 8, font: "600 11px/1 var(--dn-font-sans)", cursor: "pointer", color: trainMode === k ? "#fff" : "var(--dn-fg-muted)", background: trainMode === k ? "var(--dn-brand-base)" : "transparent" }}
            >
              {label}
            </span>
          ))}
        </div>
        {trainMode === "practice" && (
          <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "12px 14px", boxShadow: "var(--dn-shadow-card)" }}>
            <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 5 }}>How this works</div>
            <div style={{ font: "400 11px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Ask as the HCP, coach an answer, then <strong>Accept</strong> so it becomes a reviewable rule. Use <strong onClick={() => app.setStudioMode("pitch")} style={{ color: "var(--dn-brand-light)", cursor: "pointer" }}>Pitch & Script</strong> for the full slide-by-slide editor.</div>
          </div>
        )}
        {trainMode === "session" && (
          <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "12px 14px", boxShadow: "var(--dn-shadow-card)", display: "flex", flexDirection: "column", gap: 9 }}>
            <div>
              <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 5 }}>Coach a real session</div>
              <div style={{ font: "400 11px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Clone a recorded or text session into Training. Each rep line stays coachable, and accepted coaching becomes rule(s).</div>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <select
                value={selectedCoachSessionId}
                onFocus={() => { if (!sessionRows.length) void loadSessionRows(); }}
                onChange={(e) => setSelectedCoachSessionId(e.target.value)}
                disabled={sessionsLoading || sessionRows.length === 0}
                style={{ flex: 1, minWidth: 0, padding: "8px 9px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 11px/1.3 var(--dn-font-sans)", background: "#fff", color: "var(--dn-fg)" }}
              >
                {sessionRows.length === 0 ? <option>{sessionsLoading ? "Loading sessions..." : "No sessions found"}</option> : sessionRows.map((s) => (
                  <option key={s.id} value={s.id}>{s.hcp} · {s.duration} · {s.questions} question(s)</option>
                ))}
              </select>
              <button onClick={() => void cloneSessionForCoaching(selectedCoachSessionId)} disabled={!selectedCoachSessionId || sessionsLoading} style={{ ...btnPrimary, padding: "8px 10px", font: "600 11px/1 var(--dn-font-sans)", opacity: selectedCoachSessionId && !sessionsLoading ? 1 : 0.55 }}>Clone</button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span style={{ font: "500 10.5px/1.4 var(--dn-font-sans)", color: sessionCoachMsg.startsWith("Couldn't") ? "var(--dn-danger)" : "var(--dn-fg-subtle)" }}>{sessionCoachMsg || (loadedCoachSessionId ? `Loaded ${loadedCoachSessionId}` : "Pick a session to coach the full conversation.")}</span>
              <span onClick={() => void loadSessionRows()} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer", whiteSpace: "nowrap" }}>{sessionsLoading ? "Refreshing..." : "Refresh"}</span>
            </div>
          </div>
        )}
        {trainMode === "lab" && <ModelLab />}
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
                {ex.sourceSessionId && (
                  <div style={{ alignSelf: "flex-start", display: "inline-flex", gap: 6, alignItems: "center", padding: "4px 8px", borderRadius: 7, background: "rgba(6,73,172,.06)", color: "var(--dn-fg-subtle)", font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase" }}>
                    <span>Cloned session</span>
                    <span style={{ fontFamily: "var(--dn-font-mono)", letterSpacing: 0, textTransform: "none" }}>{ex.sourceHcpName ?? ex.sourceSessionId}</span>
                  </div>
                )}
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
                        {/* The greeting already carries the "★ Rep's opening line" badge above, so its
                            single version needs no second "Rep opening" label (that read as a duplicate).
                            Show a label only for non-greeting answers, or a greeting REVISION (v2+). */}
                        {(() => {
                          const label = ex.kind === "greeting"
                            ? (ex.answers.length > 1 ? `Revision v${v + 1}${isLatest ? "" : " · superseded ↓"}` : "")
                            : `${ex.kind === "overview" ? "Brand pitch" : "AI rep"}${ex.answers.length > 1 ? ` · v${v + 1}` : ""}${isLatest ? "" : " · revised ↓"}`;
                          return label ? <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-brand-base)", marginBottom: 4 }}>{label}</div> : null;
                        })()}
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
                                      onClick={() => { if (seg.stepId) setActivePlanStepId(seg.stepId); setFollowSlideId(seg.detailAidSlideId ?? null); }}
                                      title={"Click to show this line's slide in the deck panel"}
                                      style={{ ...bubbleStyle, ...(seg.stepId ? { cursor: "pointer" } : {}), ...(active ? { border: "1px solid var(--dn-brand-base)", boxShadow: "0 0 0 1px var(--dn-brand-base)" } : {}) }}
                                    >
                                      <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-accent-purple)", marginBottom: 5, display: "flex", gap: 6, alignItems: "center" }}>
                                        <span>{si + 1}.</span>
                                        <span style={{ flex: 1 }}>{seg.stepTitle ?? seg.slideTitle ?? "Approved section"}</span>
                                        {!slideChipRedundant(seg.stepTitle ?? seg.slideTitle, seg.slideTitle) && <span style={{ color: "var(--dn-fg-subtle)", textTransform: "none", letterSpacing: 0 }}>▤ shows {seg.slideTitle}</span>}
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
                            <div style={{ ...bubbleStyle, ...(a.detailAidSlideId ? { cursor: "pointer" } : {}) }} onClick={() => a.detailAidSlideId && setFollowSlideId(a.detailAidSlideId)} title={a.detailAidSlideId ? "Click to show this answer's slide in the deck panel" : undefined}>
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
                        : ex.coachings.length ? "draft rule(s) saved → activate them in Rules to affect live previews" : "no changes needed"}
                    </span>
                  </div>
                ) : !coachOpen[idx] ? (
                  // Collapsed: the thread reads as clean answers — just a small "coach this line" link
                  // at the right of the text (no big controls, no confusing "keep as is" when you're
                  // not coaching). Clicking it opens the full coach menu; Accept lives in there.
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <span onClick={() => setCoachOpen((o) => ({ ...o, [idx]: true }))} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>{ex.kind === "greeting" ? "Coach the opening line ✎" : "Coach this line ✎"}</span>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--dn-brand-light)", borderRadius: 9, padding: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>Coach this line</span>
                      <span onClick={() => setCoachOpen((o) => ({ ...o, [idx]: false }))} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", cursor: "pointer" }} title="Collapse the coach menu">▲ Collapse</span>
                    </div>
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
                      <button onClick={() => void accept(idx)} disabled={busy} style={{ ...btnPrimary, flex: 1, padding: 9, font: "600 11.5px/1 var(--dn-font-sans)" }}>{ex.kind === "greeting" ? (ex.coachings.length ? "Save opening line" : "Keep as is") : ex.coachings.length ? "Accept & save draft rules" : "Accept answer"}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {/* The deck as a doctor sees it — it follows the conversation (latest answer's slide,
            or a clicked line). Script editing lives in Pitch & Script, not here. */}
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Deck <span style={{ font: "500 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>· follows the conversation</span></span>
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
              <span onClick={() => app.setStudioMode("pitch")} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>Perfect the script →</span>
              <span onClick={() => setDeckOpen((v) => !v)} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", cursor: "pointer" }}>{deckOpen ? "Hide" : "Show"}</span>
            </span>
          </div>
          {deckOpen && (
            <div style={{ padding: "0 12px 12px" }}>
              <div style={{ height: 200, minHeight: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
                <SlideView focusId={followSlideId ?? activePlanSlideId} compact fill />
              </div>
                          </div>
          )}
        </div>
        {/* Rules from coaching — below the deck, next to the thread whose Accept creates them.
            (Script coaching in Pitch & Script saves permanently into the plan — no rules.) */}
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
          <div style={{ padding: "12px 14px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--dn-border)" }}><span style={{ font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Rules from your coaching</span><span onClick={() => app.setStudioMode("rules")} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>See all →</span></div>
          <div style={{ padding: "11px 14px", display: "flex", flexDirection: "column", gap: 9, maxHeight: 230, overflowY: "auto" }}>
            {coachingRules.length === 0 && <div style={{ textAlign: "center", padding: "14px 8px", font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Accept a coached answer and the rules behind it land here for review.</div>}
            {coachingRules.map((r) => <RuleCard key={r.id} r={r} onAccept={() => void post({ action: "ruleStatus", ruleId: r.id, status: "active" })} onReject={() => void post({ action: "ruleStatus", ruleId: r.id, status: "rejected" })} compact />)}
          </div>
        </div>
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

/** "Changes go through MLR" — for real: propose a replacement for an ACTIVE approved
 *  passage. It lands in the Build screen's MLR review queue as version N+1; the current
 *  text keeps speaking until a reviewer approves, then the old version retires. */
function ReviseApprovedText({ answerId }: { answerId?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOpen(false); setText(""); setMsg("");
  }, [answerId]);
  if (!answerId) return null;

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setMsg("Submitting to MLR review…");
    try {
      const res = await fetch("/api/content/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answerId, text: text.trim() }),
      });
      const d = (await res.json()) as { note?: string; version?: number; error?: string };
      if (!res.ok) throw new Error(d.error ?? String(res.status));
      setMsg(`v${d.version} submitted — review it in Build → Approved knowledge → MLR review. The current text stays live until approval.`);
      setOpen(false);
      setText("");
    } catch (e) {
      setMsg(`Couldn't submit: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!open && (
        <span onClick={() => { setOpen(true); setMsg(""); }} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>✎ Propose a revision → MLR review</span>
      )}
      {open && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Full replacement text for this approved passage — a reviewer approves it before the rep ever says it."
            style={{ width: "100%", minHeight: 64, resize: "vertical", padding: "8px 9px", border: "1px solid var(--dn-brand-light)", borderRadius: 8, font: "400 11px/1.45 var(--dn-font-sans)", background: "#fff" }}
          />
          <div style={{ display: "flex", gap: 7 }}>
            <button onClick={() => void submit()} disabled={busy || !text.trim()} style={{ ...btnPrimary, flex: 1, padding: "7px 9px", font: "600 10.5px/1 var(--dn-font-sans)", opacity: busy || !text.trim() ? 0.55 : 1 }}>{busy ? "…" : "Submit to MLR review"}</button>
            <button onClick={() => { setOpen(false); setText(""); }} style={{ ...btnGhost, padding: "7px 9px", font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>Cancel</button>
          </div>
        </>
      )}
      {msg && <div style={{ font: "500 10px/1.45 var(--dn-font-sans)", color: msg.startsWith("Couldn't") ? "#991b1b" : "var(--dn-fg-muted)" }}>{msg}</div>}
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
  showSlide = true,
  rehearseLabel = "▶ Rehearse",
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
  /** Hide the built-in slide preview (Pitch & Script shows the BIG deck on the left instead). */
  showSlide?: boolean;
  rehearseLabel?: string;
}) {
  // Approved-source panel starts collapsed — see the comment at its render site.
  const [showSource, setShowSource] = useState(false);
  const steps = snap?.plan.steps ?? [];
  const slides = snap?.slides ?? [];
  const step = steps.find((s) => s.id === activeStepId) ?? steps[0];
  const stepIndex = Math.max(0, steps.findIndex((s) => s.id === step?.id));

  return (
    <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
      <div style={{ padding: "13px 16px 11px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Brand pitch</div>
          <div style={{ font: "500 10.5px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 4 }}>Drafted from your approved deck — click a section to edit.</div>
        </div>
        <button onClick={onRehearse} disabled={rehearsing} title="Run the pitch in the coaching thread on the left" style={{ ...btnPrimary, flexShrink: 0, padding: "7px 10px", font: "600 10.5px/1 var(--dn-font-sans)", opacity: rehearsing ? 0.6 : 1 }}>{rehearsing ? "…" : rehearseLabel}</button>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 11 }}>
        {showSlide && (
          <div style={{ height: 178, minHeight: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--dn-border)", background: "var(--dn-surface-2)" }}>
            <SlideView focusId={activeSlideId} compact fill />
          </div>
        )}

        {!snap ? (
          <div style={{ padding: "20px 8px", textAlign: "center", font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Loading approved deck…</div>
        ) : steps.length === 0 || !step ? (
          <div style={{ padding: "20px 8px", textAlign: "center", font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>No approved deck yet — upload and approve a deck in Build to draft the pitch.</div>
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
                    <span style={{ flexShrink: 0, display: "inline-flex", gap: 2 }}>
                      <span onClick={(e) => { e.stopPropagation(); onMove(s.id, -1); }} title="Move this section earlier" style={{ width: 16, textAlign: "center", color: i === 0 ? "var(--dn-border)" : "var(--dn-fg-subtle)", cursor: i === 0 ? "default" : "pointer", font: "600 10px/1.4 var(--dn-font-sans)" }}>↑</span>
                      <span onClick={(e) => { e.stopPropagation(); onMove(s.id, 1); }} title="Move this section later" style={{ width: 16, textAlign: "center", color: i === steps.length - 1 ? "var(--dn-border)" : "var(--dn-fg-subtle)", cursor: i === steps.length - 1 ? "default" : "pointer", font: "600 10px/1.4 var(--dn-font-sans)" }}>↓</span>
                    </span>
                  </div>
                );
              })}
            </div>

            {slides.length > steps.length && (
              <div style={{ font: "500 10.5px/1.45 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", borderRadius: 8, padding: "7px 10px" }}>
                {slides.length - steps.length} approved slide(s) aren&apos;t sections yet (they still answer questions). <span onClick={onReset} style={{ cursor: "pointer", textDecoration: "underline" }}>Re-draft from deck</span> to add them.
              </div>
            )}
            <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--dn-surface-2)", paddingTop: 10 }}>
              <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)" }}>Section {stepIndex + 1} · auto-saves</span>
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
              {/* The approved source passage the script is grounded in — collapsed by default:
                  a faithful script line paraphrases its source, so showing both permanently
                  reads as the same text twice. Expand to verify grounding or propose an MLR
                  revision of the approved text itself. */}
              <div style={{ display: "grid", gap: 4 }}>
                <span onClick={() => setShowSource((v) => !v)} style={{ font: "600 8.5px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-brand-light)", cursor: "pointer" }}>{showSource ? "▾ Approved source — locked, changes go through MLR" : "▸ View approved source"}</span>
                {showSource && (
                  <>
                    <div style={{ padding: "8px 9px", borderRadius: 8, background: "#f8fafc", border: "1px dashed var(--dn-border)", font: "400 10.5px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
                      {slides.find((s) => s.id === step.slideId)?.preview ?? "Select an approved slide to anchor this section."}
                    </div>
                    <ReviseApprovedText answerId={slides.find((s) => s.id === step.slideId)?.sourceId} />
                  </>
                )}
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
  // No fabricated readiness while the snapshot loads — this used to render a made-up
  // 68% ring + a plausible checklist with no "sample" label. Honest placeholder instead.
  if (!snap) return <div style={{ padding: "48px 20px", textAlign: "center", font: "400 12.5px/1.6 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Loading readiness…</div>;
  const checklist = snap.readiness.items.map((i) => ({ label: i.label, done: i.done }));
  const pct = snap.readiness.pct;
  const itemsLeft = checklist.filter((r) => !r.done).length;
  const canLaunch = snap.readiness.canLaunch;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 18, alignItems: "start", maxWidth: 1080 }}>
      <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 14, padding: "22px 20px", boxShadow: "var(--dn-shadow-card)", textAlign: "center", position: "sticky", top: 14 }}>
        <div style={{ width: 120, height: 120, borderRadius: "50%", margin: "0 auto 16px", background: `conic-gradient(var(--dn-brand-base) ${pct}%, var(--dn-surface-2) 0)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 92, height: 92, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", font: "700 26px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{pct}%</div>
        </div>
        <div style={{ font: "600 14px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Launch readiness</div>
        <div style={{ font: "400 12px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", margin: "6px 0 18px" }}>{itemsLeft} items left.</div>
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
