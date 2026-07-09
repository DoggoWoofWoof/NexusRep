/**
 * Headless "bot join" that records a real Tavus call through NexusRep's OWN clean
 * doctor view (/hcp → Video) — not the raw Daily room — so the recording shows the
 * product (replica video + captions), never Daily's Record/Share/People chrome.
 *
 * Because it drives our UI, TavusStage logs every utterance (both sides, greeting
 * included) into the call's own session, so the transcript matches the recording.
 *
 * Flow:
 *   1. Open /hcp headless (fake mic), click the "Video" mode pill.
 *   2. TavusStage opens a Tavus conversation (its own session) + joins; the replica
 *      greets. Read window.__nexusrep for the sessionId + conversationUrl.
 *   3. Playwright records the page → a .webm of our clean UI.
 *   4. Leave + END the Tavus conversation immediately (free the concurrent slot).
 *   5. Copy the .webm to public/recordings/ and POST a recording_ready webhook so it
 *      attaches to that session. Poll the session until recordingUrl is set.
 *
 * Run: node scripts/tavus-bot-record.mjs   (CALL_SECONDS, POLL_SECONDS env)
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const CALL_SECONDS = Number(process.env.CALL_SECONDS || 30);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);
const PUBLIC_REC_DIR = join(ROOT, "public", "recordings");

function tavusKey() {
  if (process.env.TAVUS_API_KEY) return process.env.TAVUS_API_KEY;
  try {
    const m = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^\s*TAVUS_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  } catch { /* ignore */ }
  return "";
}
const KEY = tavusKey();

async function endConversation(id) {
  if (!id || !KEY) return;
  try {
    const r = await fetch(`https://tavusapi.com/v2/conversations/${id}/end`, { method: "POST", headers: { "x-api-key": KEY } });
    console.log(`  ended conversation ${id} → HTTP ${r.status}`);
  } catch (e) { console.log(`  end failed: ${e.message}`); }
}
const convIdFromUrl = (url) => { try { return new URL(url).pathname.split("/").filter(Boolean).pop() || ""; } catch { return ""; } };

async function main() {
  let browser, sessionId = null, convId = "", b64 = "";
  try {
    console.log("① opening the bare video view (fake mic)…");
    browser = await chromium.launch({
      headless: true,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    // Bare mode renders ONLY the replica full-bleed AND records it via MediaRecorder
    // (window.__nexusrepRec) starting at the first live frame — no page chrome, no boot.
    await page.goto(`${APP_URL}/hcp?bare=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);
    console.log("② waiting for the replica to connect…");
    for (let i = 0; i < 60 && !sessionId; i++) {
      const info = await page.evaluate(() => (window.__nexusrep ?? null));
      if (info?.sessionId) { sessionId = info.sessionId; convId = info.conversationUrl ? new URL(info.conversationUrl).pathname.split("/").filter(Boolean).pop() : ""; }
      if (!sessionId) await sleep(1000);
    }
    if (!sessionId) throw new Error("TavusStage did not start a conversation (Tavus configured? dev server up?)");
    console.log("   sessionId:", sessionId, "| conversationId:", convId);

    // Recorder appears when the replica's first frame is live → boot is trimmed.
    let recReady = false;
    for (let i = 0; i < 45 && !recReady; i++) { recReady = await page.evaluate(() => !!window.__nexusrepRec); if (!recReady) await sleep(1000); }
    console.log(recReady ? "   ▶ recording from the first replica frame…" : "   ⚠ recorder never started (replica didn't go live)");

    console.log(`   capturing ${CALL_SECONDS}s of the replica…`);
    await sleep(CALL_SECONDS * 1000);

    if (recReady) {
      console.log("③ stopping recorder + extracting clip…");
      b64 = await page.evaluate(() => window.__nexusrepRec.stop());
    }
    await context.close();
  } catch (e) {
    console.log("✗ error:", e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!convId && KEY) {
      try {
        const list = await (await fetch("https://tavusapi.com/v2/conversations?status=active", { headers: { "x-api-key": KEY } })).json();
        for (const c of (list.data || [])) await endConversation(c.conversation_id || c.id);
      } catch { /* ignore */ }
    } else {
      await endConversation(convId);
    }
  }

  let recordingUrl = null;
  if (b64 && sessionId) {
    mkdirSync(PUBLIC_REC_DIR, { recursive: true });
    const fname = `nexusrep-${convId || sessionId}.webm`;
    writeFileSync(join(PUBLIC_REC_DIR, fname), Buffer.from(b64, "base64"));
    const publicUrl = `${APP_URL}/recordings/${fname}`;
    console.log(`④ publishing recording (${Math.round(b64.length * 0.75 / 1024)} KB) →`, publicUrl);
    const hook = await fetch(`${APP_URL}/api/tavus/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "recording_ready", conversation_id: convId, properties: { recording_url: publicUrl } }),
    });
    console.log("   webhook →", hook.status);
  } else {
    console.log("⚠ no clip captured (recorder produced no data).");
  }

  if (sessionId) {
    console.log(`⑤ polling /api/sessions/${sessionId} up to ${POLL_SECONDS}s…`);
    const deadline = Date.now() + POLL_SECONDS * 1000;
    let turns = 0;
    while (Date.now() < deadline) {
      try {
        const s = await (await fetch(`${APP_URL}/api/sessions/${sessionId}`)).json();
        turns = s?.turns?.length ?? 0;
        if (s?.session?.recordingUrl) { recordingUrl = s.session.recordingUrl; break; }
      } catch { /* */ }
      await sleep(3000);
    }
    console.log(`   transcript turns logged: ${turns}`);
  }

  if (recordingUrl) {
    console.log("\n✅ DONE — recording + both-sided transcript on the same session:");
    console.log("   session:", sessionId);
    console.log("   recording:", recordingUrl);
    console.log("   → Sessions → this session: clean replica video + click-through transcript.");
  } else {
    console.log("\n⚠ recordingUrl not set — check logs above.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
