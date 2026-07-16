/**
 * Runs a short, clean Tavus timing pass:
 * - starts the real HCP preview
 * - turns on the Tavus video rep
 * - waits for greeting audio to begin
 * - lets greeting speak for 2s, then asks Q1
 * - waits for each answer to start, lets it speak for 2s, then asks the next question
 * - prints prompt->audio and approved-text->audio timing for each turn
 *
 * Run with the dev server already up:
 *   node scripts/measure-tavus-bargein-latency.mjs
 */
import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";

const APP = process.env.APP_URL || "http://localhost:3000";
const EDGE_EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BROWSER_EXECUTABLE = process.env.NEXUSREP_BROWSER_EXECUTABLE || (existsSync(EDGE_EXE) ? EDGE_EXE : "");
const QUESTIONS = [
  "Could you give me the big picture for this asset?",
  "What is the broad late-stage plan studying?",
  "Why focus on the clotting cascade rather than the usual pathway?",
  "If a patient tells me they had bleeding while on the study drug, what happens?",
  "How should I think about it versus Eliquis?",
].slice(0, Math.max(1, Math.min(5, Number(process.env.NEXUSREP_MEASURE_LIMIT || 5) || 5)));

async function main() {
  let browser;
  let conversationId = "";
  try {
    browser = await chromium.launch({
      headless: true,
      ...(BROWSER_EXECUTABLE ? { executablePath: BROWSER_EXECUTABLE } : {}),
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
    const browserLatencyEvents = [];
    page.on("pageerror", (error) => console.log(`[browser:error] ${error.message}`));
    page.on("console", async (msg) => {
      const text = msg.text();
      if (text.includes("[nexusrep-latency]")) {
        const args = await Promise.all(msg.args().map((arg) => arg.jsonValue().catch(() => undefined)));
        const payload = args.find((arg) => arg && typeof arg === "object" && "question" in arg);
        if (payload) browserLatencyEvents.push({ ...payload, capturedAt: Date.now() });
      }
      if (/daily|tavus|nexusrep|error|warn|failed|denied/i.test(text)) {
        console.log(`[browser:${msg.type()}] ${text.slice(0, 700)}`);
      }
    });

    await page.goto(`${APP}/hcp`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: /Start session/i }).click({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.body.innerText.includes("GUIDED OVERVIEW") || document.body.innerText.includes("Video rep"),
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: /Video rep/i }).click({ timeout: 20_000 });

    const session = await waitForSession(page);
    conversationId = conversationIdFromUrl(session.conversationUrl);
    console.log(`session=${session.sessionId}`);
    console.log(`conversation=${conversationId || "(unknown)"}`);

    await waitForLive(page);
    console.log("video=live");

    const greetingStartsBefore = await timingCount(page, "vendor_started_speaking");
    await waitForTimingAfter(page, "vendor_started_speaking", greetingStartsBefore, 30_000)
      .catch(async () => {
        const current = await timingCount(page, "vendor_started_speaking");
        if (current <= greetingStartsBefore) throw new Error("Greeting audio did not start.");
      });
    const greetingStart = await latestTiming(page, "vendor_started_speaking");
    console.log(`greetingAudioStartedAt=${new Date(greetingStart.at).toISOString()}`);
    await sleep(2000);

    const results = [];
    for (const question of QUESTIONS) {
      const result = await askAndWaitForAnswerAudio(page, question, browserLatencyEvents);
      results.push(result);
      console.log(formatResult(result));
      await sleep(2000);
    }

    await sleep(4000);
    const detail = await loadSession(session.sessionId);
    const transcript = (detail.turns || []).map((turn) => ({
      speaker: turn.speaker,
      text: String(turn.text || "").replace(/\s+/g, " ").trim(),
      slideId: turn.detailAidSlideId || null,
      route: turn.route || null,
    }));
    const finalState = await page.evaluate(() => ({
      latency: window.__nexusrepLatency || [],
      timingTail: (window.__nexusrepTiming || []).slice(-120),
      visibleTextTail: document.body.innerText.slice(Math.max(0, document.body.innerText.length - 6000)),
    }));
    finalState.browserLatencyEvents = browserLatencyEvents;

    console.log("");
    console.log("JSON_SUMMARY_START");
    console.log(JSON.stringify({ session, conversationId, questions: QUESTIONS, results, transcript, finalState }, null, 2));
    console.log("JSON_SUMMARY_END");

    await ctx.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (conversationId) await endConversation(conversationId).catch((error) => {
      console.log(`endConversation failed: ${error.message}`);
    });
  }
}

async function askAndWaitForAnswerAudio(page, question, browserLatencyEvents) {
  await waitForAskReady(page);
  const beforeLatency = browserLatencyEvents.length;
  const beforeRepStarts = await timingCount(page, "vendor_started_speaking");
  const sentAt = Date.now();

  const input = page.getByPlaceholder(/Type|talk|question/i).first();
  await input.fill(question, { timeout: 20_000 });
  await page.getByRole("button", { name: /^Ask$/i }).click({ timeout: 20_000 });

  const latency = await waitForBrowserLatencyAfter(browserLatencyEvents, beforeLatency, 70_000);
  const audioStart = await latestTiming(page, "vendor_started_speaking", beforeRepStarts);
  const sessionId = await page.evaluate(() => window.__nexusrep?.sessionId || null);
  const detail = sessionId ? await loadSession(sessionId) : null;
  const repTurn = findLikelyRepTurn(detail, question);
  return {
    question,
    promptToAudioMs: Number.isFinite(audioStart?.at) ? audioStart.at - sentAt : latency.transcriptToAudioMs ?? null,
    transcriptToAudioMs: latency.transcriptToAudioMs ?? null,
    finalTextToAudioMs: latency.finalVendorTextToAudioMs ?? latency.repFinalUtteranceToAudioMs ?? null,
    firstVendorTextToAudioMs: latency.firstVendorTextToAudioMs ?? null,
    latency,
    answer: repTurn?.text || null,
    slideId: repTurn?.detailAidSlideId || null,
    route: repTurn?.route || null,
  };
}

async function waitForSession(page) {
  for (let i = 0; i < 90; i += 1) {
    const session = await page.evaluate(() => window.__nexusrep || null);
    if (session?.sessionId) return session;
    await sleep(1000);
  }
  throw new Error("Tavus session id was not exposed.");
}

async function waitForLive(page) {
  await page.waitForFunction(
    () => {
      const t = window.__nexusrepVideoAgent;
      return typeof t?.getStage === "function" && t.getStage() === "live";
    },
    undefined,
    { timeout: 90_000 },
  );
}

async function waitForAskReady(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((button) => {
        const text = (button.textContent || "").trim().toLowerCase();
        return text === "ask" && !button.disabled;
      }),
    undefined,
    { timeout: 120_000 },
  );
}

async function waitForBrowserLatencyAfter(events, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.length > count) return events[events.length - 1];
    await sleep(250);
  }
  throw new Error(`Timed out waiting for browser latency event after ${timeoutMs}ms.`);
}

async function timingCount(page, type) {
  return await page.evaluate((eventType) => (window.__nexusrepTiming || []).filter((event) => event.type === eventType).length, type);
}

async function latestTiming(page, type, minCount = 0) {
  return await page.evaluate(
    ({ eventType, count }) => {
      const rows = (window.__nexusrepTiming || []).filter((event) => event.type === eventType);
      return rows.length > count ? rows[rows.length - 1] : null;
    },
    { eventType: type, count: minCount },
  );
}

async function waitForTimingAfter(page, type, before, timeoutMs) {
  await page.waitForFunction(
    ({ eventType, count }) => (window.__nexusrepTiming || []).filter((event) => event.type === eventType).length > count,
    { eventType: type, count: before },
    { timeout: timeoutMs },
  );
}

async function loadSession(sessionId) {
  const res = await fetch(`${APP}/api/sessions/${sessionId}`);
  if (!res.ok) return null;
  return await res.json();
}

function findLikelyRepTurn(detail, question) {
  const turns = detail?.turns || [];
  let hcpSeen = false;
  let best = null;
  for (const turn of turns) {
    if (turn.speaker === "hcp" && similar(turn.text, question)) {
      hcpSeen = true;
      best = null;
      continue;
    }
    if (hcpSeen && turn.speaker === "rep") {
      best = turn;
    }
  }
  return best || [...turns].reverse().find((turn) => turn.speaker === "rep") || null;
}

function similar(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  return left === right || left.includes(right.slice(0, 24)) || right.includes(left.slice(0, 24));
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatResult(result) {
  return [
    `question="${result.question}"`,
    `promptToAudio=${ms(result.promptToAudioMs)}`,
    `textToAudio=${ms(result.finalTextToAudioMs)}`,
    `route=${result.route || "unknown"}`,
    `slide=${result.slideId || "none"}`,
  ].join(" | ");
}

function ms(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function conversationIdFromUrl(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

async function endConversation(id) {
  await fetch(`${APP}/api/realtime/conversation/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: id }),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
