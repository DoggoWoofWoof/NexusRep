"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppState } from "./NexusRepApp";
import { btnGhost, btnPrimary } from "./NexusRepApp";
import { CONVERSATION, DEFAULT_RULES, KNOWLEDGE_ASSETS, setupTopicsFor, type Rule } from "./data";
import { TavusStage } from "../_components/TavusStage";
import { useBrand } from "../_components/useBrand";

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
  const readyPct = readyPctNum != null ? `${readyPctNum}%` : "68%";
  const itemsLeft = snap ? snap.readiness.items.filter((i) => !i.done).length : 2;

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
          {mode === "setup" ? "Answer DocNexus's questions on the left — it drafts each section on the right." : mode === "train" ? "Rehearse with the rep and coach any line. Your feedback becomes a scoped rule." : mode === "rules" ? "Guardrails are locked. Drafts from coaching need review before they go live." : "Resolve the checklist, then submit for approval."}
        </span>
      </div>

      {mode === "setup" && <BuildMode repName={repName} snap={snap} post={post} app={app} />}
      {mode === "train" && <TrainMode rules={rules} post={post} repName={repName} app={app} />}
      {mode === "rules" && <RulesMode rules={rules} post={post} />}
      {mode === "readiness" && <ReadinessMode snap={snap} submitState={submitState} onSubmit={submit} />}
    </div>
  );
}

/* ---------- BUILD MODE ---------- */
function BuildMode({ repName, snap, post, app }: { repName: string; snap: StudioSnap | null; post: (body: Record<string, unknown>) => Promise<StudioSnap | null>; app: AppState }) {
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
      const d = (await res.json()) as { parsed?: { blocks: number; slides: number; safetyStatements?: number }; error?: string };
      if (res.ok && d.parsed) {
        const safetyCount = d.parsed.safetyStatements ?? 0;
        setUploadMsg(`Parsed ${d.parsed.blocks} block(s)${safetyCount ? ` and ${safetyCount} ISI statement(s)` : ""} from "${file.name}" — pending MLR review.`);
        if (safetyCount) void loadSafety();
        void loadKnowledge();
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

  const loadKnowledge = async () => {
    try {
      const res = await fetch("/api/content/knowledge");
      if (!res.ok) return;
      setKnowledge((await res.json()) as KnowledgeSnap);
    } catch {
      /* keep static fallback assets */
    }
  };

  useEffect(() => {
    void loadSafety();
    void loadKnowledge();
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
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, paddingLeft: 31, marginTop: 2 }}>
              {topics[step]!.chips.map((c) => (
                <span key={c[0]} onClick={() => answer(c[1])} style={{ padding: "8px 12px", background: "#fff", border: "1px solid var(--dn-brand-light)", borderRadius: 9, font: "600 11.5px/1.2 var(--dn-font-sans)", color: "var(--dn-brand-base)", cursor: "pointer" }}>{c[0]}</span>
              ))}
            </div>
          )}
          {step >= topics.length && <div style={{ paddingLeft: 31, font: "500 11.5px/1.4 var(--dn-font-sans)", color: "var(--dn-success)" }}>All set — review and confirm each section on the right.</div>}
        </div>
        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--dn-border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
            <span style={{ font: "500 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{Math.min(step, topics.length)} of {topics.length} answered</span>
            {step < topics.length && <span onClick={autoFill} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>Decide for me →</span>}
          </div>
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
                      <input type="file" accept=".pptx,.ppt,.pdf,.txt,.md" onChange={(e) => void onUpload(e.target.files?.[0])} style={{ display: "none" }} />
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
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", marginBottom: 8 }}>
                      <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Source library</span>
                      <span style={{ font: "400 10.5px/1.35 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Uploaded assets and MLR status</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
                      {KNOWLEDGE_ASSETS.map((c) => (
                        <div key={c.mlrId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 11px", border: "1px solid var(--dn-surface-2)", borderRadius: 9 }}>
                          <span style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, background: "var(--dn-surface-2)", display: "flex", alignItems: "center", justifyContent: "center", font: "700 10px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{c.kind}</span>
                          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}><span style={{ display: "block", font: "600 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span><span style={{ display: "block", font: "400 10px/1.2 var(--dn-font-mono)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{c.mlrId}</span></span>
                          <span style={{ font: "600 9.5px/1 var(--dn-font-sans)", padding: "3px 7px", borderRadius: 5, background: c.status === "Active" ? "var(--dn-accent-green-bg)" : "var(--dn-accent-yellow-bg)", color: c.status === "Active" ? "#166534" : "#92400e" }}>{c.status}</span>
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
                      <LabeledSelect label="Specialty" options={["Cardiology", "Interventional", "Electrophysiology", "Vascular Neurology"]} />
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
  return (
    <label style={{ display: "block" }}>
      <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>{label}</span>
      <select value={value} onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value); }} style={{ marginTop: 6, width: "100%", padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "500 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)", background: "#fff" }}>
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
interface RepAnswer {
  text: string;
  route: string;
  isi: boolean;
  detailAidSlideId?: string | null;
  /** Did an LLM actually apply the coaching? false = no AI key (approved text only). */
  usedLlm: boolean;
}
/** One question and the rep's answer(s) — each coaching note produces a fresh re-answer.
 *  A "greeting" exchange has no HCP question: it coaches the rep's OPENING line. */
interface Exchange {
  q: string;
  kind?: "greeting";
  answers: RepAnswer[]; // v1, then a new version per coaching note
  coachings: string[]; // the notes applied so far (visible in the thread)
  scope: CoachScope;
  accepted: boolean;
  ruleCount?: number; // rules saved on accept
}

/** Split a rep answer into its coachable body and the active approved ISI block. */
function splitIsi(text: string): [string, string | null] {
  const parts = text.split(/\n\nImportant Safety Information:\s*/);
  return parts.length > 1 ? [parts[0]!.trim(), parts.slice(1).join(" ").trim()] : [text, null];
}

function TrainMode({ rules, post, repName, app }: { rules: UiRule[]; post: (body: Record<string, unknown>) => Promise<StudioSnap | null>; repName: string; app: AppState }) {
  const brand = useBrand();
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [coachDraft, setCoachDraft] = useState<Record<number, string>>({});
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);

  const coachingRules = rules.filter((r) => r.source === "feedback");

  const greetingExchange = (): Exchange => ({ q: "", kind: "greeting", answers: [{ text: brand?.greeting ?? "", route: "greeting", isi: false, detailAidSlideId: null, usedLlm: true }], coachings: [], scope: "persona", accepted: false });

  // Seed the OPENING-LINE exchange once the greeting loads, so the disclosure itself can be
  // coached like any answer (previously it was the one line you couldn't change here).
  useEffect(() => {
    if (brand?.greeting) setExchanges((xs) => (xs.length === 0 ? [greetingExchange()] : xs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand?.greeting]);

  // Rehearse the rep with the coaching so far applied. A greeting exchange rewrites the opening
  // line (keeping the mandatory disclosures); any other rewrites the answer. Rehearsal only — the
  // preview endpoint creates no session, logs no turn, enqueues no follow-up.
  const runPreview = async (ex: { kind?: "greeting"; q: string; current: string }, coaching: string[]): Promise<RepAnswer> => {
    try {
      const body = ex.kind === "greeting" ? { kind: "greeting", current: ex.current, coaching } : { text: ex.q, coaching };
      const res = await fetch("/api/train/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        const d = (await res.json()) as { response?: string; route?: string; isiDelivered?: boolean; detailAidSlideId?: string | null; usedLlm?: boolean };
        return { text: d.response ?? "", route: d.route ?? "", isi: !!d.isiDelivered, detailAidSlideId: d.detailAidSlideId ?? null, usedLlm: !!d.usedLlm };
      }
    } catch {
      /* fall through */
    }
    const turn = CONVERSATION[0]!;
    return { text: turn.response, route: turn.intent, isi: turn.isi, detailAidSlideId: null, usedLlm: false };
  };

  const ask = async () => {
    if (asking) return;
    const q = input.trim() || brand?.tryQuestions[0] || "Tell me about this therapy.";
    setAsking(true);
    setInput("");
    const a = await runPreview({ q, current: "" }, []);
    setExchanges((xs) => [...xs, { q, answers: [a], coachings: [], scope: "persona", accepted: false }]);
    setAsking(false);
  };

  // Add a coaching note → the rep tries again with all notes so far. Iterate until happy.
  const reAnswer = async (idx: number) => {
    const note = (coachDraft[idx] ?? "").trim();
    const ex = exchanges[idx];
    if (!note || !ex || ex.accepted || busyIdx !== null) return;
    const coachings = [...ex.coachings, note];
    setBusyIdx(idx);
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 11, borderTop: "1px solid var(--dn-surface-2)" }}>
            <span style={{ font: "400 11px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Coach a line → the rep tries again</span>
            <span onClick={() => { setExchanges([greetingExchange()]); setCoachDraft({}); }} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>↺ Restart</span>
          </div>
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "12px 14px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-fg-subtle)", marginBottom: 5 }}>How this works</div>
          <div style={{ font: "400 11px/1.55 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>The first card is the rep&apos;s <strong>opening line</strong> — coach it too. For any answer, add a note and the rep re-answers; when it&apos;s right, <strong>Accept</strong> and your coaching is saved as reviewable rule(s).</div>
        </div>
      </div>

      {/* Coaching thread */}
      <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", display: "flex", flexDirection: "column", height: 604 }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}><span style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Coach the rep</span><span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Refine each answer, then accept</span></div>
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
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
                        <div style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--dn-brand-base)", marginBottom: 4 }}>{ex.kind === "greeting" ? "Rep opening" : "AI rep"}{ex.answers.length > 1 ? ` · v${v + 1}` : ""}{isLatest ? "" : " · revised ↓"}</div>
                        {(() => {
                          const [bodyText, isiText] = splitIsi(a.text);
                          return (
                            <div style={{ padding: "10px 12px", background: offLabel ? "#fffbeb" : isLatest ? "var(--dn-surface-2)" : "#fafbfc", border: `1px solid ${offLabel ? "#fcd34d" : "var(--dn-border)"}`, borderRadius: 9, font: "400 12px/1.55 var(--dn-font-sans)", color: isLatest ? "var(--dn-fg)" : "var(--dn-fg-subtle)", opacity: isLatest ? 1 : 0.7 }}>
                              <div style={{ whiteSpace: "pre-wrap" }}>{bodyText}</div>
                              {isiText && (
                                <div style={{ marginTop: 9, paddingTop: 8, borderTop: "1px dashed var(--dn-border)", font: "400 10px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>
                                  <span style={{ fontWeight: 600, letterSpacing: ".02em" }}>Required safety information · active approved block — </span>{isiText}
                                </div>
                              )}
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
                        : ex.coachings.length ? "your coaching saved as rule(s) → review in Rules" : "no changes needed"}
                    </span>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--dn-brand-light)", borderRadius: 9, padding: 10 }}>
                    <textarea value={coachDraft[idx] ?? ""} onChange={(e) => setCoachDraft((d) => ({ ...d, [idx]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void reAnswer(idx); }} placeholder={ex.kind === "greeting" ? "Coach the opening line — warmer, shorter, mention the brand… (disclosures are kept)" : "Coach this answer — e.g. be more concise, lead with the FDA status, warmer tone…"} style={{ width: "100%", padding: "9px 11px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 12px/1.45 var(--dn-font-sans)", resize: "vertical", minHeight: 42, background: "var(--dn-surface-2)" }} />
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

      {/* Rules from feedback */}
      <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)", overflow: "hidden" }}>
        <div style={{ padding: "14px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--dn-border)" }}><span style={{ font: "600 12.5px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Rules from your coaching</span><span onClick={() => app.setStudioMode("rules")} style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>See all →</span></div>
        <div style={{ padding: "13px 16px", display: "flex", flexDirection: "column", gap: 10, maxHeight: 520, overflowY: "auto" }}>
          {coachingRules.length === 0 && <div style={{ textAlign: "center", padding: "22px 8px", font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>Accept a coached answer and the rules behind it land here for review.</div>}
          {coachingRules.map((r) => <RuleCard key={r.id} r={r} onAccept={() => void post({ action: "ruleStatus", ruleId: r.id, status: "active" })} onReject={() => void post({ action: "ruleStatus", ruleId: r.id, status: "rejected" })} compact />)}
        </div>
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
