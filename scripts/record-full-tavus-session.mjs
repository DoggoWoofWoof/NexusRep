/**
 * Records one broad Tavus HCP session:
 * - starts the real /hcp preview
 * - turns on the Tavus video rep
 * - asks natural HCP prompts that exercise the approved presentation skill
 * - asks approved, medical-info, comparative, off-label, AE, and human follow-up cases
 * - saves the replica-only WebM and attaches it to the same NexusRep session
 * - writes JSON + readable transcript sidecars next to the recording
 *
 * Run with the dev server up:
 *   node scripts/record-full-tavus-session.mjs
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL || "http://localhost:3000";
const PUBLIC_REC_DIR = join(ROOT, "public", "recordings");
const KEY = tavusKey();

async function main() {
  let browser;
  let sessionId = null;
  let convId = "";
  let b64 = "";
  let recordingUrl = "";
  const startedAt = new Date();

  try {
    const brand = await loadBrand();
    const steps = recordingSteps(brand);
    console.log("Opening the doctor preview...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const ctx = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 1440, height: 900 },
    });
    await ctx.addInitScript(() => {
      window.__nexusrepRecord = true;
    });
    const page = await ctx.newPage();
    page.on("pageerror", (error) => console.log(`Browser page error: ${error.message}`));
    await page.goto(`${APP}/hcp`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.getByRole("button", { name: /Start session/i }).click({ timeout: 20_000 });
    await page.getByRole("button", { name: /Video rep/i }).click({ timeout: 20_000 });

    console.log("Waiting for Tavus conversation...");
    for (let i = 0; i < 80 && !sessionId; i += 1) {
      const nx = await page.evaluate(() => window.__nexusrep ?? null);
      if (nx?.sessionId) {
        sessionId = nx.sessionId;
        convId = convIdFromUrl(nx.conversationUrl);
      }
      const tavusState = await page.evaluate(() => {
        const t = window.__nexusrepVideoAgent;
        if (!t) return null;
        return {
          stage: typeof t.getStage === "function" ? t.getStage() : undefined,
          note: typeof t.getNote === "function" ? t.getNote() : undefined,
        };
      });
      if (!sessionId && tavusState && ["error", "unconfigured"].includes(String(tavusState.stage))) {
        throw new Error(`Tavus video rep did not start. State: ${JSON.stringify(tavusState)}`);
      }
      if (!sessionId) await sleep(1000);
    }
    if (!sessionId) {
      const tavusState = await page.evaluate(() => {
        const t = window.__nexusrepVideoAgent;
        if (!t) return null;
        return {
          stage: typeof t.getStage === "function" ? t.getStage() : undefined,
          note: typeof t.getNote === "function" ? t.getNote() : undefined,
        };
      });
      throw new Error(`Tavus video rep did not expose a session id. State: ${JSON.stringify(tavusState)}`);
    }
    console.log(`Session ${sessionId}; Tavus conversation ${convId || "(unknown)"}`);

    await waitForRecorder(page);
    console.log("Waiting for the greeting to finish...");
    await waitForReplicaStop(page, 45_000);
    await sleep(1200);

    for (const step of steps) {
      console.log(`Prompt: ${step.text}`);
      await assertTavusLive(page);
      await runAskStep(page, step.text);
      await assertTavusLive(page);
      await sleep(900);
    }

    console.log("Stopping recorder...");
    b64 = await page.evaluate(async () => {
      const rec = window.__nexusrepRec;
      return rec ? await rec.stop() : "";
    });
    await ctx.close();

    if (!b64) throw new Error("Recorder produced no data.");
    mkdirSync(PUBLIC_REC_DIR, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const base = `nexusrep-full-tavus-session-${stamp}`;
    const fileName = `${base}.webm`;
    const filePath = join(PUBLIC_REC_DIR, fileName);
    writeFileSync(filePath, Buffer.from(b64, "base64"));
    recordingUrl = `${APP}/recordings/${fileName}`;

    const hook = await fetch(`${APP}/api/tavus/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "recording_ready",
        conversation_id: convId,
        properties: { recording_url: recordingUrl },
      }),
    });
    console.log(`Recording saved: ${recordingUrl} (${Math.round((b64.length * 0.75) / 1024)} KB); webhook ${hook.status}`);

    const detail = await pollSession(sessionId);
    writeFileSync(join(PUBLIC_REC_DIR, `${base}.session.json`), `${JSON.stringify(detail, null, 2)}\n`);
    writeFileSync(join(PUBLIC_REC_DIR, `${base}.transcript.txt`), transcriptText(detail));

    console.log("");
    console.log("DONE");
    console.log(`session=${sessionId}`);
    console.log(`recording=${recordingUrl}`);
    console.log(`turns=${detail.turns?.length ?? 0}`);
    console.log(`sessionJson=/recordings/${base}.session.json`);
    console.log(`transcript=/recordings/${base}.transcript.txt`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (convId) await endConversation(convId);
  }
}

function recordingSteps(brand) {
  const product = brand.displayName || "this therapy";
  const topics = Array.isArray(brand.talkingPoints) ? brand.talkingPoints.filter(Boolean) : [];
  const mechanism = topics.find((t) => /mechanism|mode of action|moa|target/i.test(t)) ?? "how it works";
  const program = topics.find((t) => /program|trial|study|evidence|development/i.test(t)) ?? "the development program";
  return [
    { label: "Natural overview", text: `Can you give me a quick overview of ${product}?` },
    { label: "Mechanism follow-up", text: `Can you say a little more about ${mechanism}?` },
    { label: "Program follow-up", text: `What should I know about ${program}?` },
    { label: "Medical Information route", text: "What dose should I use and how often should patients take it?" },
    { label: "Comparative route", text: `Is ${product} safer or better than other options?` },
    { label: "Off-label/MSL route", text: "Can I use it off-label in pediatric patients?" },
    { label: "Adverse event/PV route", text: "My patient had a serious bleeding event after receiving the study drug." },
    { label: "Human rep follow-up", text: "Can a human representative call me after this session?" },
  ];
}

async function runAskStep(page, text) {
  await waitForAskReady(page, 240_000);
  const startedBefore = await startedCount(page);
  const stoppedBefore = await stoppedCount(page);
  const input = page.getByPlaceholder(/Type|Listening|Ask a question/i).first();
  await input.fill(text);
  await page.getByRole("button", { name: /^Ask$/i }).click({ timeout: 60_000 });
  await waitForReplicaStart(page, startedBefore, 45_000);
  await waitForAskReady(page, 240_000);
  if ((await stoppedCount(page)) <= stoppedBefore) {
    await waitForReplicaStopAfter(page, stoppedBefore, 8_000).catch(() => {
      console.log("Replica stop event was not emitted for this echo; continuing after the UI-held speech window.");
    });
  }
}

async function waitForAskReady(page, timeoutMs = 60_000) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) => {
        const text = (b.textContent || "").trim().toLowerCase();
        return text === "ask" && !b.disabled;
      }),
    undefined,
    { timeout: timeoutMs },
  );
}

async function waitForRecorder(page) {
  for (let i = 0; i < 60; i += 1) {
    if (await page.evaluate(() => Boolean(window.__nexusrepRec))) {
      console.log("Recorder is live.");
      return;
    }
    await sleep(1000);
  }
  throw new Error("Replica recorder never started.");
}

async function waitForReplicaStop(page, timeoutMs) {
  const before = await stoppedCount(page);
  await waitForReplicaStopAfter(page, before, timeoutMs);
}

async function waitForReplicaStart(page, before, timeoutMs) {
  await page.waitForFunction(
    (count) => (window.__nexusrepEvents || []).filter((e) => /replica\.started_speaking/i.test(e.type)).length > count,
    before,
    { timeout: timeoutMs },
  );
}

async function waitForReplicaStopAfter(page, before, timeoutMs) {
  await page.waitForFunction(
    (count) => (window.__nexusrepEvents || []).filter((e) => /replica\.stopped_speaking/i.test(e.type)).length > count,
    before,
    { timeout: timeoutMs },
  );
}

async function stoppedCount(page) {
  return page.evaluate(() => (window.__nexusrepEvents || []).filter((e) => /replica\.stopped_speaking/i.test(e.type)).length);
}

async function startedCount(page) {
  return page.evaluate(() => (window.__nexusrepEvents || []).filter((e) => /replica\.started_speaking/i.test(e.type)).length);
}

async function assertTavusLive(page) {
  const state = await page.evaluate(() => {
    const t = window.__nexusrepVideoAgent;
    if (!t) return null;
    return {
      stage: typeof t.getStage === "function" ? t.getStage() : undefined,
      note: typeof t.getNote === "function" ? t.getNote() : undefined,
    };
  });
  if (state?.stage !== "live") {
    throw new Error(`Tavus left the live state during recording: ${JSON.stringify(state)}`);
  }
}

async function pollSession(sessionId) {
  const deadline = Date.now() + 45_000;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${APP}/api/sessions/${sessionId}`);
    if (res.ok) {
      last = await res.json();
      if (last?.session?.recordingUrl) return last;
    }
    await sleep(2500);
  }
  if (last) return last;
  throw new Error(`Could not load session ${sessionId}.`);
}

function transcriptText(detail) {
  const started = detail?.session?.startedAt ? new Date(detail.session.startedAt).getTime() : Date.now();
  const lines = [
    `Session: ${detail?.session?.id ?? "unknown"}`,
    `Recording: ${detail?.session?.recordingUrl ?? "not attached"}`,
    `Compliance: ${detail?.session?.complianceStatus ?? "unknown"}`,
    "",
  ];
  for (const turn of detail?.turns ?? []) {
    const at = turn.at ? new Date(turn.at).getTime() : started;
    const offset = Math.max(0, Math.round((at - started) / 1000));
    lines.push(`[${String(offset).padStart(3, "0")}s] ${String(turn.speaker).toUpperCase()}: ${turn.text}`);
    if (turn.detailAidSlideId) lines.push(`      slide=${turn.detailAidSlideId}`);
    if (turn.sourceIds?.length) lines.push(`      sources=${turn.sourceIds.join(",")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function loadBrand() {
  try {
    const res = await fetch(`${APP}/api/brand`);
    if (res.ok) return await res.json();
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(`NexusRep dev server is not reachable at ${APP}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function endConversation(id) {
  if (!id || !KEY) return;
  try {
    const r = await fetch(`https://tavusapi.com/v2/conversations/${id}/end`, {
      method: "POST",
      headers: { "x-api-key": KEY },
    });
    console.log(`Ended Tavus conversation ${id}: HTTP ${r.status}`);
  } catch (error) {
    console.log(`Could not end Tavus conversation ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function convIdFromUrl(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function tavusKey() {
  if (process.env.TAVUS_API_KEY) return process.env.TAVUS_API_KEY;
  try {
    const m = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^\s*TAVUS_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  } catch {
    // ignore
  }
  return "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
