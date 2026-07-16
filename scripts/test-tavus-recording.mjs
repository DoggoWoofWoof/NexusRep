/**
 * TEST: does TAVUS'S OWN recording actually work? (vs. the client-side MediaRecorder the other
 * scripts use). It runs a short REAL doctor session, ends it, then:
 *   1) polls Tavus's conversation API for a recording URL — proves Tavus recorded, key only, NO tunnel needed.
 *   2) polls our /api/sessions/{id} for recordingUrl — proves the recording_ready webhook attached it
 *      (needs a reachable NEXUSREP_PUBLIC_URL so Tavus can call us back).
 *
 * It does NOT set window.__nexusrepRecord, so no client capture happens — this is purely the Tavus path.
 *
 * Run with the dev server up (and TAVUS_API_KEY set):  node scripts/test-tavus-recording.mjs
 * Costs Tavus credits (~1 short call). Verdict printed at the end.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL || "http://localhost:3000";
const envVal = (name) => {
  if (process.env[name]) return process.env[name];
  try { return (readFileSync(join(ROOT, ".env.local"), "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, "m")) || [])[1]?.replace(/^["']|["']$/g, "").trim() || ""; }
  catch { return ""; }
};
const KEY = envVal("TAVUS_API_KEY");
const QUESTIONS = ["What is Milvexian and how does it work?", "What's the LIBREXIA program?"];

/** GET one conversation (verbose) straight from Tavus and pull any recording URL + status. */
async function tavusConversation(convId) {
  const res = await fetch(`https://tavusapi.com/v2/conversations/${convId}?verbose=true`, { headers: { "x-api-key": KEY } });
  if (!res.ok) return { httpStatus: res.status, status: null, recordingUrl: null, raw: await res.text() };
  const raw = await res.json();
  const props = raw?.properties ?? {};
  const isUrl = (v) => typeof v === "string" && (/^https?:\/\//.test(v) || v.startsWith("/recordings/"));
  const recordingUrl = [raw.recording_url, raw.download_url, raw.recording_s3_url, raw.recording, props.recording_url, props.download_url, props.s3_url, props.recording].find(isUrl) ?? null;
  return { httpStatus: 200, status: raw.status ?? null, recordingUrl, raw };
}

async function main() {
  if (!KEY) { console.error("✗ TAVUS_API_KEY not set (env or .env.local) — can't test the Tavus recording path."); process.exit(1); }
  let browser, sessionId = null, convId = "";
  try {
    console.log("① opening the doctor preview (NO client capture — testing Tavus's own recording)…");
    browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1360, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(`${APP}/hcp`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);
    await page.getByRole("button", { name: /Start session/i }).click({ timeout: 15000 });
    await sleep(1000);
    console.log("② turning on the video rep…");
    await page.getByRole("button", { name: /Video rep/i }).click({ timeout: 15000 });

    for (let i = 0; i < 60 && !sessionId; i++) {
      const nx = await page.evaluate(() => window.__nexusrep ?? null);
      if (nx?.sessionId) { sessionId = nx.sessionId; convId = nx.conversationUrl ? new URL(nx.conversationUrl).pathname.split("/").filter(Boolean).pop() : ""; }
      if (!sessionId) await sleep(1000);
    }
    if (!sessionId) throw new Error("video rep never connected (check TAVUS_API_KEY / NEXUSREP_PUBLIC_URL)");
    console.log(`   session=${sessionId}  conv=${convId}`);

    console.log("③ waiting for the greeting, then asking a couple of questions (content to record)…");
    for (let i = 0; i < 30; i++) { if (await page.evaluate(() => (window.__nexusrepEvents ?? []).some((e) => /replica\.stopped_speaking/i.test(e.type)))) break; await sleep(1000); }
    await sleep(2500);
    for (const q of QUESTIONS) {
      console.log("   asking:", q);
      await page.getByPlaceholder(/Type|Listening|Ask a question/i).first().fill(q);
      await page.getByRole("button", { name: /^Ask$/i }).click();
      await sleep(16000);
    }
    await sleep(3000);
    console.log("④ ending the session (closes the call)…");
    await ctx.close();
  } catch (e) {
    console.log("✗ session error:", e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (convId) { try { await fetch(`https://tavusapi.com/v2/conversations/${convId}/end`, { method: "POST", headers: { "x-api-key": KEY } }); } catch { /* */ } }
  }
  if (!convId) { console.log("⚠ no conversation id — nothing to check."); return; }

  console.log("\n⑤ polling TAVUS for a recording (key only, no tunnel needed) — recordings process async…");
  let tavusUrl = null, lastStatus = null;
  for (let i = 0; i < 20 && !tavusUrl; i++) {
    const c = await tavusConversation(convId);
    lastStatus = c.status;
    if (i === 0) console.log("   first conversation snapshot:", JSON.stringify(c.raw)?.slice(0, 600));
    if (c.recordingUrl) { tavusUrl = c.recordingUrl; break; }
    console.log(`   [${(i + 1) * 15}s] status=${c.status ?? "?"} recording=none`);
    await sleep(15000);
  }

  console.log("\n⑥ checking whether our webhook attached it to the session (needs reachable NEXUSREP_PUBLIC_URL)…");
  let attached = null;
  for (let i = 0; i < 4 && !attached; i++) {
    try { const s = await (await fetch(`${APP}/api/sessions/${sessionId}`)).json(); attached = s?.session?.recordingUrl ?? null; } catch { /* */ }
    if (!attached) await sleep(5000);
  }

  console.log("\n──────── VERDICT ────────");
  console.log(`Tavus produced a recording : ${tavusUrl ? "✅ YES" : "❌ NO"}  ${tavusUrl ?? `(last status=${lastStatus ?? "?"})`}`);
  console.log(`Webhook attached to session: ${attached ? "✅ YES" : "❌ NO"}  ${attached ?? ""}`);
  if (!tavusUrl) console.log("→ Tavus isn't returning a recording: likely the account/plan has recording disabled. Client-side capture is the way to go.");
  else if (!attached) console.log("→ Tavus records, but the callback didn't reach us: check NEXUSREP_PUBLIC_URL is a live public tunnel and TAVUS_LLM_KEY matches.");
  else console.log("→ Tavus recording works end-to-end. The webhook path is good.");
}
main().catch((e) => { console.error(e); process.exit(1); });
