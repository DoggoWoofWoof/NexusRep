/**
 * Records a full multi-turn doctor session as a REPLICA-ONLY clip + a timestamped
 * transcript, so Session-detail can replay it in the preview layout (recorded rep in
 * the avatar slot + click-through transcript + slides that move with playback).
 *
 * Drives the real doctor view (/hcp → HcpExperience), turns on the video rep, WAITS
 * for the greeting to finish (no race), then asks a scripted sequence. TavusStage
 * records only the replica stream (window.__nexusrepRecord) starting at its first live
 * frame (boot trimmed). Run: node scripts/record-session-replay.mjs
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL || "http://localhost:3000";
const PUBLIC_REC_DIR = join(ROOT, "public", "recordings");
const KEY = (readFileSync(join(ROOT, ".env.local"), "utf8").match(/^\s*TAVUS_API_KEY\s*=\s*(.+)\s*$/m) || [])[1]?.replace(/^["']|["']$/g, "").trim();

const QUESTIONS = [
  "What is Milvexian and how does it work?",
  "What's the LIBREXIA program?",
  "What's the development and FDA status?",
];

async function endConv(id) {
  if (!id || !KEY) return;
  try { await fetch(`https://tavusapi.com/v2/conversations/${id}/end`, { method: "POST", headers: { "x-api-key": KEY } }); console.log("  ended", id); } catch { /* */ }
}

async function main() {
  let browser, sessionId = null, convId = "", b64 = "";
  try {
    console.log("① opening the doctor preview…");
    browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1360, height: 860 } });
    await ctx.addInitScript(() => { window.__nexusrepRecord = true; }); // record the replica-only clip
    const page = await ctx.newPage();
    await page.goto(`${APP}/hcp`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2500);
    await page.getByRole("button", { name: /Start session/ }).click({ timeout: 15000 });
    await sleep(1200);
    console.log("② turning on the video rep…");
    await page.getByRole("button", { name: /Video rep/ }).click({ timeout: 15000 });

    for (let i = 0; i < 60 && !sessionId; i++) {
      const nx = await page.evaluate(() => window.__nexusrep ?? null);
      if (nx?.sessionId) { sessionId = nx.sessionId; convId = nx.conversationUrl ? new URL(nx.conversationUrl).pathname.split("/").filter(Boolean).pop() : ""; }
      if (!sessionId) await sleep(1000);
    }
    if (!sessionId) throw new Error("video rep never connected");
    console.log("   session:", sessionId, "| conv:", convId);

    // Wait for the replica recorder to start (first live frame).
    for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.__nexusrepRec)) break; await sleep(1000); }

    // RACE FIX: do NOT ask until the rep has finished its greeting. Wait for a
    // replica.stopped_speaking event (greeting done), then a small buffer.
    console.log("③ waiting for the rep to finish loading + greeting…");
    let greetDone = false;
    for (let i = 0; i < 30 && !greetDone; i++) {
      greetDone = await page.evaluate(() => (window.__nexusrepEvents ?? []).some((e) => /replica\.stopped_speaking/i.test(e.type)));
      if (!greetDone) await sleep(1000);
    }
    await sleep(2500);

    for (const q of QUESTIONS) {
      console.log("④ asking:", q);
      await page.getByPlaceholder(/Type|Listening|Ask a question/).first().fill(q);
      await page.getByRole("button", { name: /^Ask$/ }).click();
      await sleep(17000); // gated answer (~13s) + replica speaks (echo) + slide advances
    }
    await sleep(2500);

    console.log("⑤ stopping the replica recorder…");
    if (await page.evaluate(() => !!window.__nexusrepRec)) b64 = await page.evaluate(() => window.__nexusrepRec.stop());
    await ctx.close();
  } catch (e) {
    console.log("✗", e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (convId) await endConv(convId);
    else if (KEY) { try { const d = await (await fetch("https://tavusapi.com/v2/conversations?status=active", { headers: { "x-api-key": KEY } })).json(); for (const c of (d.data || [])) await endConv(c.conversation_id || c.id); } catch { /* */ } }
  }

  if (b64 && convId) {
    mkdirSync(PUBLIC_REC_DIR, { recursive: true });
    const fname = `replay-${convId}.webm`;
    writeFileSync(join(PUBLIC_REC_DIR, fname), Buffer.from(b64, "base64"));
    const url = `${APP}/recordings/${fname}`;
    const hook = await fetch(`${APP}/api/tavus/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event_type: "recording_ready", conversation_id: convId, properties: { recording_url: url } }) });
    console.log(`⑥ published replica clip (${Math.round(b64.length * 0.75 / 1024)} KB) →`, url, "| webhook", hook.status);
    try { const s = await (await fetch(`${APP}/api/sessions/${sessionId}`)).json(); console.log(`\n✅ REPLAY READY — session ${sessionId}: ${s.turns?.length ?? 0} turns, recording ${s.session?.recordingUrl ? "attached" : "pending"}.`); } catch { /* */ }
  } else {
    console.log("⚠ no replica clip captured.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
