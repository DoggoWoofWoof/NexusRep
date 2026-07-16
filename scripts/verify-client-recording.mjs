/**
 * VERIFY the client-side recording end-to-end: open the real /hcp preview, turn on the video rep,
 * let it record (the app's own recordSession — NOT the __nexusrepRecord bot flag), click "End video",
 * and confirm the session got a /recordings/capture-*.webm URL attached (client capture → upload →
 * attach). This is the path we use because Tavus's own recording is off on this account.
 *
 * Run with the dev server up:  APP_URL=http://localhost:3001 node scripts/verify-client-recording.mjs
 */
import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";

const APP = process.env.APP_URL || "http://localhost:3000";

async function main() {
  let browser, sessionId = null;
  try {
    console.log("① opening /hcp (app auto-records via recordSession)…");
    browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1360, height: 860 } });
    const page = await ctx.newPage();
    await page.goto(`${APP}/hcp`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2000);
    await page.getByRole("button", { name: /Start session/i }).click({ timeout: 20000 });
    await sleep(1000);
    await page.getByRole("button", { name: /Video rep/i }).click({ timeout: 20000 });
    for (let i = 0; i < 60 && !sessionId; i++) {
      sessionId = await page.evaluate(() => window.__nexusrep?.sessionId ?? null);
      if (!sessionId) await sleep(1000);
    }
    if (!sessionId) throw new Error("video rep never connected");
    console.log("   session:", sessionId);

    console.log("② waiting for the recorder to start + greeting…");
    for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.__nexusrepRec)) break; await sleep(1000); }
    const recStarted = await page.evaluate(() => !!window.__nexusrepRec);
    console.log("   recorder live:", recStarted);
    for (let i = 0; i < 25; i++) { if (await page.evaluate(() => (window.__nexusrepEvents ?? []).some((e) => /replica\.stopped_speaking/i.test(e.type))) ) break; await sleep(1000); }
    await sleep(3000);

    console.log("③ asking one question so there's content, then ending the video…");
    try { await page.getByPlaceholder(/Type|Listening|Ask a question/i).first().fill("What is Milvexian?"); await page.getByRole("button", { name: /^Ask$/i }).click(); await sleep(8000); } catch { /* answer optional */ }
    await page.getByRole("button", { name: /End video/i }).click({ timeout: 15000 });
    console.log("   clicked End video (finalizeRecording → upload)…");
    await sleep(6000); // let the upload complete
    await ctx.close();
  } catch (e) {
    console.log("✗", e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!sessionId) { console.log("⚠ no session — can't verify."); return; }
  console.log("④ checking the session for an attached recording…");
  let url = null;
  for (let i = 0; i < 10 && !url; i++) {
    try { const s = await (await fetch(`${APP}/api/sessions/${sessionId}`)).json(); url = s?.session?.recordingUrl ?? null; } catch { /* */ }
    if (!url) await sleep(2000);
  }
  console.log("\n──────── VERDICT ────────");
  console.log(`recording attached: ${url ? "✅ YES" : "❌ NO"}  ${url ?? ""}`);
  console.log(url && /\/recordings\/capture-/.test(url) ? "→ client capture → upload → attach works end-to-end." : "→ no client-captured recording attached — check the browser console / server log.");
}
main().catch((e) => { console.error(e); process.exit(1); });
