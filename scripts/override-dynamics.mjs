// Verifies (A) Charlie is the DEFAULT but any replica can still be selected (override) + cleared,
// and (B) the knowledge/scripts are LIVE — the pitch script + try-questions grow as approved
// content is added, and can be scoped/tightened to one source.
import fs from "node:fs";
const BASE = "http://localhost:3100";
const SAMPLES = "C:/Users/Swastik/Desktop/NexusRep/sample-uploads";
const b64 = (p) => fs.readFileSync(`${SAMPLES}/${p}`).toString("base64");
function jar() { const c = []; return { h: () => ({ "Content-Type": "application/json", Cookie: c.join("; ") }), absorb: (r) => { for (const x of r.headers.getSetCookie?.() ?? []) c.push(x.split(";")[0]); } }; }
async function api(j, m, p, body) { const r = await fetch(`${BASE}${p}`, { method: m, headers: j.h(), ...(body ? { body: JSON.stringify(body) } : {}) }); j.absorb(r); try { return JSON.parse(await r.text()); } catch { return {}; } }
async function login(u, p) { const j = jar(); await api(j, "POST", "/api/auth", { action: "login", username: u, password: p }); return j; }
const check = (n, ok, d = "") => console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`);
const planSteps = async (j) => ((await api(j, "GET", "/api/presentation/plan")).plan?.steps ?? []).length;
const tryQ = async (j) => ((await api(j, "GET", "/api/brand")).tryQuestions ?? []).length;

async function approveAll(j) {
  const mlr = await api(j, "GET", "/api/mlr");
  for (const a of mlr.pending ?? []) await api(j, "POST", "/api/mlr", { action: "approve", answerId: a.id });
  for (const s of mlr.pendingSafety ?? []) await api(j, "POST", "/api/mlr", { action: "approve", safetyId: s.id });
}

(async () => {
  // ── A. Default = Charlie, still overridable ─────────────────────────
  console.log("\n### A. Default rep = Charlie, but fully overridable ###");
  const j = await login("clean", "clean123");
  const a0 = await api(j, "GET", "/api/realtime/agents");
  const defName = (a0.agents ?? []).find((x) => x.id === a0.defaultReplicaId)?.name;
  check("default is Charlie (resolved by name, not hardcoded)", /charlie/i.test(defName ?? ""), `default=${defName}`);
  check("no agent explicitly selected yet (using the default)", a0.selected === null);
  const other = (a0.agents ?? []).find((x) => x.status === "ready" && !/charlie/i.test(x.name));
  const sel = await api(j, "POST", "/api/realtime/agents", { action: "select", agentId: other.id, name: other.name });
  check("can OVERRIDE the default — select another replica", sel.selected === other.id, `selected=${other.name}`);
  const cleared = await api(j, "POST", "/api/realtime/agents", { action: "select", agentId: null });
  const defName2 = (cleared.agents ?? []).find((x) => x.id === cleared.defaultReplicaId)?.name;
  check("clearing returns to the Charlie default", cleared.selected === null && /charlie/i.test(defName2 ?? ""), `default=${defName2}`);

  // ── B. Knowledge + scripts are LIVE (grow with content, scope to one source) ──
  console.log("\n### B. Knowledge/scripts update as content changes ###");
  const k = await login("swastik", "swastik123");
  await api(k, "POST", "/api/content/ingest", { filename: "Milvexian_Medical_Information_Deck.pptx", contentBase64: b64("Milvexian_Medical_Information_Deck.pptx") });
  await approveAll(k);
  const steps1 = await planSteps(k); const tq1 = await tryQ(k);
  check("script + try-questions generated from the deck alone", steps1 >= 2 && tq1 >= 2, `${steps1} steps, ${tq1} try-questions`);

  await api(k, "POST", "/api/content/ingest", { filename: "Milvexian_HCP_FAQ.pdf", contentBase64: b64("Milvexian_HCP_FAQ.pdf") });
  await api(k, "POST", "/api/content/ingest", { filename: "Milvexian_Prescribing_Information.pdf", contentBase64: b64("Milvexian_Prescribing_Information.pdf") });
  await approveAll(k);
  const steps2 = await planSteps(k); const tq2 = await tryQ(k);
  check("adding more approved docs GROWS the script (knowledge updated)", steps2 > steps1, `${steps1} → ${steps2} steps`);
  check("try-questions track the live approved knowledge", tq2 >= tq1, `${tq1} → ${tq2}`);

  // Scope the script to ONE source → a tighter, focused script (the "remove/curate" lever).
  const know = await api(k, "GET", "/api/content/knowledge");
  const deck = (know.documents ?? []).find((d) => /deck/i.test(d.title) && d.status === "active");
  if (deck) {
    const reset = await api(k, "POST", "/api/presentation/plan", { action: "reset", assetId: deck.id });
    const scoped = (reset.plan?.steps ?? []).length;
    check("script can be scoped to ONE source (tighter than all-sources)", scoped > 0 && scoped < steps2, `all=${steps2} → deck-only=${scoped}`);
  } else check("deck asset found for scoping", false);
})().catch((e) => { console.error("ERROR", e.message); process.exit(1); });
