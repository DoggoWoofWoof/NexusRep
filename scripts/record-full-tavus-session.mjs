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
const LLM_KEY = tavusLlmKey();

async function main() {
  let browser;
  let sessionId = null;
  let convId = "";
  let b64 = "";
  let recordingUrl = "";
  let recMeta = null;
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
    page.on("console", (msg) => {
      const text = msg.text();
      if (/daily|tavus|nexusrep|error|warn|failed|denied/i.test(text)) {
        console.log(`Browser ${msg.type()}: ${text.slice(0, 800)}`);
      }
    });
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
    console.log("Letting the greeting start, then asking naturally over it to verify barge-in...");
    await waitForTimingAfter(page, "vendor_started_speaking", await timingCount(page, "vendor_started_speaking"), 12_000).catch(() => undefined);
    await sleep(1800);

    for (const step of steps) {
      console.log(`Prompt: ${step.text}`);
      await assertTavusLive(page);
      await runAskStep(page, step.text);
      await assertTavusLive(page);
      await sleep(900);
    }

    console.log("Holding recorder for final Tavus audio tail...");
    await sleep(18_000);

    console.log("Stopping recorder...");
    recMeta = await page.evaluate(() => {
      const rec = window.__nexusrepRec;
      const timing = window.__nexusrepTiming || [];
      const events = window.__nexusrepEvents || [];
      return {
        recordingStartedAt: rec?.startedAt || null,
        stoppedAt: Date.now(),
        timing,
        events,
      };
    });
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

    let detail = await loadSession(sessionId);
    const synced = await syncRecordedTimeline(sessionId, detail, recMeta);
    if (synced) detail = await loadSession(sessionId);

    const hookUrl = `${APP}/api/tavus/webhook${LLM_KEY ? `?k=${encodeURIComponent(LLM_KEY)}` : ""}`;
    const hook = await fetch(hookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "recording_ready",
        conversation_id: convId,
        properties: { recording_url: recordingUrl },
      }),
    });
    console.log(`Recording saved: ${recordingUrl} (${Math.round((b64.length * 0.75) / 1024)} KB); webhook ${hook.status}`);

    detail = await pollSession(sessionId);
    writeFileSync(join(PUBLIC_REC_DIR, `${base}.session.json`), `${JSON.stringify(detail, null, 2)}\n`);
    writeFileSync(join(PUBLIC_REC_DIR, `${base}.transcript.txt`), transcriptText(detail));
    writeFileSync(join(PUBLIC_REC_DIR, `${base}.timing.json`), `${JSON.stringify(recMeta, null, 2)}\n`);

    console.log("");
    console.log("DONE");
    console.log(`session=${sessionId}`);
    console.log(`recording=${recordingUrl}`);
    console.log(`turns=${detail.turns?.length ?? 0}`);
    console.log(`sessionJson=/recordings/${base}.session.json`);
    console.log(`transcript=/recordings/${base}.transcript.txt`);
    console.log(`timing=/recordings/${base}.timing.json`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (convId) await endConversation(convId);
  }
}

function recordingSteps(brand) {
  const product = brand.displayName || "this therapy";
  return [
    { label: "Approved mechanism", text: `What is ${product} and how does it work?` },
    { label: "Program follow-up", text: "What should I know about the LIBREXIA program?" },
    { label: "Medical Information route", text: "What dose should I use and how often should patients take it?" },
    { label: "Off-label/MSL route", text: "Can I use it off-label in pediatric patients?" },
    { label: "Adverse event/PV route", text: "My patient had a serious bleeding event after receiving the study drug." },
  ];
}

async function runAskStep(page, text) {
  await waitForAskReady(page, 240_000);
  const repFinalBefore = await timingCount(page, "rep_final_utterance");
  const input = page.getByPlaceholder(/Type|Listening|Ask a question/i).first();
  await input.fill(text);
  await page.getByRole("button", { name: /^Ask$/i }).click({ timeout: 60_000 });
  const answered = await waitForTimingAfter(page, "rep_final_utterance", repFinalBefore, 90_000).then(
    () => true,
    () => false,
  );
  if (!answered) {
    console.log("Replica final answer event was not emitted for this turn; continuing after the UI-held response window.");
  }
  const stoppedAfterAnswer = await timingCount(page, "vendor_stopped_speaking");
  await waitForAskReady(page, 240_000);
  await waitForTimingAfter(page, "vendor_stopped_speaking", stoppedAfterAnswer, 120_000).catch(() => {
    console.log("Replica stop event was not emitted for this turn; continuing after the UI-held speech window.");
  });
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
  let last = null;
  for (let i = 0; i < 60; i += 1) {
    if (await page.evaluate(() => Boolean(window.__nexusrepRec))) {
      console.log("Recorder is live.");
      return;
    }
    last = await recorderSnapshot(page);
    if (["ended", "error", "unconfigured"].includes(String(last?.stage))) {
      throw new Error(`Replica recorder never started because the video agent left the live path: ${JSON.stringify(last)}`);
    }
    if (i > 0 && i % 10 === 0) console.log(`Recorder still waiting: ${JSON.stringify(last)}`);
    await sleep(1000);
  }
  throw new Error(`Replica recorder never started. Last video state: ${JSON.stringify(last)}`);
}

async function recorderSnapshot(page) {
  return page.evaluate(() => {
    const t = window.__nexusrepVideoAgent;
    const media = (selector) =>
      [...document.querySelectorAll(selector)].map((el) => {
        const stream = el.srcObject;
        return {
          tag: el.tagName.toLowerCase(),
          readyState: el.readyState,
          paused: el.paused,
          tracks: stream && typeof stream.getTracks === "function"
            ? stream.getTracks().map((track) => ({ kind: track.kind, readyState: track.readyState, muted: track.muted, enabled: track.enabled }))
            : [],
        };
      });
    return {
      stage: typeof t?.getStage === "function" ? t.getStage() : null,
      note: typeof t?.getNote === "function" ? t.getNote() : null,
      hasRecorder: Boolean(window.__nexusrepRec),
      media: [...media("video"), ...media("audio")],
      recentTiming: (window.__nexusrepTiming || []).slice(-8),
      recentEvents: (window.__nexusrepEvents || []).slice(-8),
    };
  });
}

async function waitForReplicaStop(page, timeoutMs) {
  const before = await stoppedCount(page);
  await waitForReplicaStopAfter(page, before, timeoutMs);
}

async function timingCount(page, type) {
  return page.evaluate((eventType) => (window.__nexusrepTiming || []).filter((e) => e.type === eventType).length, type);
}

async function waitForTimingAfter(page, type, before, timeoutMs) {
  await page.waitForFunction(
    ({ eventType, count }) => (window.__nexusrepTiming || []).filter((e) => e.type === eventType).length > count,
    { eventType: type, count: before },
    { timeout: timeoutMs },
  );
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

async function loadSession(sessionId) {
  const res = await fetch(`${APP}/api/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Could not load session ${sessionId}: HTTP ${res.status}`);
  return await res.json();
}

async function syncRecordedTimeline(sessionId, detail, recMeta) {
  const recordingStartedAt = Number(recMeta?.recordingStartedAt);
  const stoppedAt = Number(recMeta?.stoppedAt);
  if (!Number.isFinite(recordingStartedAt) || !Number.isFinite(stoppedAt) || stoppedAt <= recordingStartedAt) {
    console.log("Timeline sync skipped: recorder start/stop metadata was unavailable.");
    return false;
  }
  const offsets = computeTurnOffsets(detail, recMeta);
  const textOverrides = computeTurnTextOverrides(detail, recMeta);
  const durationSeconds = Math.max(1, Math.ceil((stoppedAt - recordingStartedAt) / 1000));
  const res = await fetch(`${APP}/api/dev/session-demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "resequence",
      sessionId,
      durationSeconds,
      timelineStartedAt: new Date(recordingStartedAt).toISOString(),
      turnOffsetsSeconds: offsets,
      turnTextOverrides: textOverrides,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Timeline sync failed: HTTP ${res.status} ${text}`);
  console.log(`Timeline synced from recorder events (${durationSeconds}s): ${offsets.map((n) => n.toFixed(1)).join(", ")}`);
  return true;
}

function computeTurnTextOverrides(detail, recMeta) {
  const recStart = Number(recMeta?.recordingStartedAt);
  const events = Array.isArray(recMeta?.timing) ? recMeta.timing : [];
  const used = new Set();
  const turns = detail?.turns ?? [];
  let cursor = 0;
  return turns.map((turn) => {
    if (turn.speaker !== "hcp") return null;
    const event = bestEventForTurn(turn, events, used, ["typed_respond_sent"], recStart, cursor);
    if (!event?.text) return null;
    const offset = (Number(event.at) - recStart) / 1000;
    if (Number.isFinite(offset)) cursor = Math.max(cursor, offset);
    return String(event.text).trim() || null;
  });
}

function computeTurnOffsets(detail, recMeta) {
  const recStart = Number(recMeta?.recordingStartedAt);
  const events = Array.isArray(recMeta?.timing) ? recMeta.timing : [];
  const used = new Set();
  const turns = detail?.turns ?? [];
  const offsets = [];
  let cursor = 0;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const preferred = turn.speaker === "rep"
      ? ["caption_release", "rep_final_utterance"]
      : ["typed_respond_sent", "hcp_final_utterance"];
    const event = bestEventForTurn(turn, events, used, preferred, recStart, cursor);
    let offset = event ? (Number(event.at) - recStart) / 1000 : NaN;
    if (!Number.isFinite(offset)) {
      const nextRep = turn.speaker === "hcp" ? nextRepEventOffset(turns, events, used, i, recStart, cursor) : NaN;
      offset = Number.isFinite(nextRep) ? Math.max(cursor, nextRep - 2.5) : cursor;
    }
    if (offset < cursor) offset = cursor;
    offsets.push(round1(offset));
    cursor = offset + 0.2;
  }
  return offsets;
}

function bestEventForTurn(turn, events, used, preferredTypes, recStart, minOffset, markUsed = true) {
  const turnNorm = normalizeText(turn.text);
  let best = null;
  for (let i = 0; i < events.length; i += 1) {
    if (used.has(i)) continue;
    const event = events[i];
    if (!preferredTypes.includes(event?.type)) continue;
    if (!Number.isFinite(Number(event.at)) || Number(event.at) < recStart) continue;
    const offset = (Number(event.at) - recStart) / 1000;
    if (offset + 0.5 < minOffset) continue;
    const eventNorm = normalizeText(event.text ?? "");
    const score = textScore(turnNorm, eventNorm);
    const threshold = turn.speaker === "rep" ? 0.78 : 0.55;
    if (score < threshold) continue;
    const typeBonus = preferredTypes.indexOf(event.type) === 0 ? 0.08 : 0;
    const scored = { event, index: i, score: score + typeBonus - Math.max(0, offset - minOffset) * 0.002 };
    if (!best || scored.score > best.score) best = scored;
  }
  if (best) {
    if (markUsed) used.add(best.index);
    return best.event;
  }
  return null;
}

function nextRepEventOffset(turns, events, used, fromIndex, recStart, minOffset) {
  const nextRep = turns.slice(fromIndex + 1).find((t) => t.speaker === "rep");
  if (!nextRep) return NaN;
  const event = bestEventForTurn(nextRep, events, used, ["caption_release", "rep_final_utterance"], recStart, minOffset, false);
  if (!event) return NaN;
  return (Number(event.at) - recStart) / 1000;
}

function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/important safety information:.*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function textScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const aw = new Set(a.split(/\s+/).filter(Boolean));
  const bw = new Set(b.split(/\s+/).filter(Boolean));
  let hit = 0;
  for (const w of aw) if (bw.has(w)) hit += 1;
  return hit / Math.max(aw.size, bw.size, 1);
}

function estimatedTurnGap(turn) {
  const words = String(turn?.text ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (turn?.speaker === "hcp") return Math.min(4.5, Math.max(1.2, words / 4));
  return Math.min(24, Math.max(3, words / 2.6));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function transcriptText(detail) {
  const started = detail?.session?.startedAt ? new Date(detail.session.startedAt).getTime() : Date.now();
  const lines = [
    `Session: ${detail?.session?.id ?? "unknown"}`,
    `Recording: ${detail?.session?.recordingUrl ?? "not attached"}`,
    `Duration: ${detail?.session?.durationSeconds ?? "unknown"}s`,
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

function tavusLlmKey() {
  if (process.env.TAVUS_LLM_KEY) return process.env.TAVUS_LLM_KEY;
  try {
    const m = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^\s*TAVUS_LLM_KEY\s*=\s*(.+)\s*$/m);
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
