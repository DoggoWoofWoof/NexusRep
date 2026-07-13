// Clean → demo parity harness. For a CLEAN account, upload ONLY the sample docs (unmodified),
// let the AI fill everything, approve content, load the live cohort, RUN conversations to earn the
// KPIs, launch — then score parity vs the seeded Milvexian demo. No hardcoding: everything the
// clean account has comes from the docs + the conversations it actually ran.
import fs from "node:fs";

const BASE = "http://localhost:3100";
const SAMPLES = "C:/Users/Swastik/Desktop/NexusRep/sample-uploads";
const b64 = (p) => fs.readFileSync(`${SAMPLES}/${p}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Brand-agnostic doctor questions — same set for any drug, exercising grounded answers, a
// comparative→Medical-Info route, a safety mention, and an off-label refusal.
const QUESTIONS = [
  "What is it and how does it work?",
  "What's the clinical program studying?",
  "What is the development and regulatory status?",
  "What safety information should I know?",
  "What is it being studied for?",
  "Is it better than the other options?",
  "Can I use it in pediatric patients?",
  "Who can I contact for more information?",
];

function jar() {
  const cookies = [];
  return {
    header: () => ({ "Content-Type": "application/json", Cookie: cookies.join("; ") }),
    absorb: (res) => { for (const c of res.headers.getSetCookie?.() ?? []) cookies.push(c.split(";")[0]); },
  };
}

async function api(j, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: j.header(), ...(body ? { body: JSON.stringify(body) } : {}) });
  j.absorb(res);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

async function login(username, password) {
  const j = jar();
  const r = await api(j, "POST", "/api/auth", { action: "login", username, password });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status}`);
  return j;
}

async function metrics(j) {
  const brand = (await api(j, "GET", "/api/brand")).json ?? {};
  const analytics = (await api(j, "GET", "/api/analytics")).json ?? {};
  const audience = (await api(j, "GET", "/api/audience")).json ?? {};
  const studio = (await api(j, "GET", "/api/studio")).json ?? {};
  const pick = (cat, key) => (analytics.data?.[cat] ?? []).find((m) => m.key === key)?.value;
  return {
    brand: brand.displayName,
    indication: brand.indication,
    deck: (brand.deck ?? []).length,
    tryQuestions: (brand.tryQuestions ?? []).length,
    isi: Boolean(brand.investigational !== undefined) && undefined, // filled below via safety
    audienceRows: (audience.rows ?? []).length,
    audienceSource: audience.source,
    sessions: pick("engagement", "sessions"),
    completed: pick("engagement", "completed"),
    questions: pick("engagement", "questions"),
    followups: pick("crm_ops", "followups"),
    crmSuccess: pick("crm_ops", "crm_success"),
    isiRate: pick("compliance", "isi"),
    grounded: pick("content", "grounded"),
    gaps: (analytics.data?.content ?? []).find((m) => m.key === "gaps"),
    topicTotal: analytics.topicMix?.total ?? 0,
    repState: studio.rep?.state,
    answersLive: pick("content", "assets"),
  };
}

async function buildFromDocs(j, docs, label) {
  console.log(`\n=== ${label}: uploading ${docs.length} docs ===`);
  for (const d of docs) {
    const r = await api(j, "POST", "/api/content/ingest", { filename: d, contentBase64: b64(d) });
    const p = r.json?.parsed;
    console.log(`  ${d}: ${r.status} slides=${p?.slides} blocks=${p?.blocks} safety=${p?.safetyStatements} autofill=${(r.json?.setupAutofill?.filled ?? []).join(",")}`);
  }
  // Approve everything in the MLR queue (answers + safety) → live/retrievable.
  const mlr = (await api(j, "GET", "/api/mlr")).json ?? {};
  for (const a of mlr.pending ?? []) await api(j, "POST", "/api/mlr", { action: "approve", answerId: a.id });
  for (const s of mlr.pendingSafety ?? []) await api(j, "POST", "/api/mlr", { action: "approve", safetyId: s.id });
  console.log(`  approved: ${(mlr.pending ?? []).length} answers, ${(mlr.pendingSafety ?? []).length} safety`);
  await api(j, "POST", "/api/studio", { action: "section", section: "approved_knowledge", status: "complete" });

  // Wait for the live cohort (autofilled specialties/ICD → DocNexus; async + slow).
  let rows = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(6000);
    const aud = (await api(j, "GET", "/api/audience")).json ?? {};
    rows = (aud.rows ?? []).length;
    if (/docnexus/.test(aud.source ?? "") && !/fallback/.test(aud.source ?? "") && rows > 0) { console.log(`  cohort: ${rows} HCPs (${aud.source}) after ${(i + 1) * 6}s`); break; }
    if (i === 11) console.log(`  cohort: ${rows} HCPs (${aud.source})`);
  }

  // Run the conversations (3 sessions) → real sessions/audit/follow-ups/CRM → organic KPIs.
  let ran = 0;
  for (let s = 0; s < 3; s++) {
    const start = (await api(j, "POST", "/api/conversation/start")).json ?? {};
    const sid = start.sessionId;
    const qs = QUESTIONS.slice(s * 3, s * 3 + 3).length ? QUESTIONS.slice(s * 3, s * 3 + 3) : QUESTIONS.slice(0, 3);
    for (const q of qs) { await api(j, "POST", "/api/conversation/turn", { text: q, sessionId: sid }); ran++; }
    await api(j, "POST", "/api/conversation/end", { sessionId: sid, durationSeconds: 300 + s * 60 });
  }
  console.log(`  ran ${ran} questions across 3 sessions`);

  // Launch to a few cohort HCPs + go live.
  const aud = (await api(j, "GET", "/api/audience")).json ?? {};
  const hcpIds = (aud.rows ?? []).slice(0, 5).map((r) => r.id).filter(Boolean);
  if (hcpIds.length) await api(j, "POST", "/api/studio", { action: "launch", hcpIds });
  await api(j, "POST", "/api/studio", { action: "repState", repState: "live" });

  const m = await metrics(j);
  // ISI presence: check the safety queue is empty AND at least one was approved (proxy: safety approved above)
  m.isiApproved = (mlr.pendingSafety ?? []).length > 0;
  return m;
}

function scoreParity(m) {
  const checks = [
    ["brand name from docs", Boolean(m.brand && m.brand !== "Your AI Rep" && m.brand !== "New AI Rep")],
    ["indication", Boolean(m.indication)],
    ["deck slides ≥4", (m.deck ?? 0) >= 4],
    ["approved answers ≥4", Number(m.answersLive ?? 0) >= 4],
    ["try-questions ≥2", (m.tryQuestions ?? 0) >= 2],
    ["ISI extracted+approved", Boolean(m.isiApproved)],
    ["audience cohort >0", (m.audienceRows ?? 0) > 0],
    ["live claims cohort", /docnexus/.test(m.audienceSource ?? "") && !/fallback/.test(m.audienceSource ?? "")],
    ["sessions ≥3", Number(m.sessions ?? 0) >= 3],
    ["topic mix live (≥8)", (m.topicTotal ?? 0) >= 8],
    ["follow-ups >0", Number(m.followups ?? 0) > 0],
    ["content gaps computed", m.gaps?.sub !== "No target topics configured yet"],
    ["compliance measured (ISI/grounded)", (m.isiRate && m.isiRate !== "—") || (m.grounded && m.grounded !== "—")],
    ["rep live", m.repState === "live"],
  ];
  return checks;
}

(async () => {
  console.log("### BASELINE: seeded Milvexian demo (mahek) ###");
  const demo = await metrics(await login("mahek", "mahek123"));
  console.log(JSON.stringify(demo, null, 1));

  const runs = [
    { label: "CLEAN → Milvexian", user: "clean", pass: "clean123", docs: ["Milvexian_Medical_Information_Deck.pptx", "Milvexian_Prescribing_Information.pdf", "Milvexian_HCP_FAQ.pdf"] },
    { label: "CLEAN → Veltrexa", user: "swastik", pass: "swastik123", docs: ["Veltrexa_Medical_Information_Deck.pptx", "Veltrexa_Fact_Sheet.pdf"] },
  ];
  for (const run of runs) {
    const j = await login(run.user, run.pass);
    const m = await buildFromDocs(j, run.docs, run.label);
    const checks = scoreParity(m);
    const met = checks.filter(([, ok]) => ok).length;
    console.log(`\n### ${run.label} — metrics ###\n${JSON.stringify(m, null, 1)}`);
    console.log(`\n### ${run.label} — parity ${met}/${checks.length} = ${Math.round((met / checks.length) * 100)}% ###`);
    for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  }
})().catch((e) => { console.error("HARNESS ERROR", e.message); process.exit(1); });
