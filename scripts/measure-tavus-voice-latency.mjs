/**
 * Voice-only Tavus timing pass.
 *
 * This does NOT use typed conversation.respond. It generates a WAV file with spoken
 * HCP questions, feeds that file to Chromium as the microphone, turns the video-call
 * mic on, and lets Tavus ASR + turn taking drive the custom-LLM callback.
 *
 * Run with the dev server already up:
 *   node scripts/measure-tavus-voice-latency.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const APP = process.env.APP_URL || "http://localhost:3000";
const START_SILENCE_SEC = Number(process.env.NEXUSREP_VOICE_START_SILENCE_SEC || 2);
const BETWEEN_SEC = Number(process.env.NEXUSREP_VOICE_BETWEEN_SEC || 7);
const END_SILENCE_SEC = Number(process.env.NEXUSREP_VOICE_END_SILENCE_SEC || 60);
const RUN_EXTRA_MS = Number(process.env.NEXUSREP_VOICE_RUN_EXTRA_MS || 18_000);
const MIC_AFTER_GREETING = !/^(0|false|no)$/i.test(process.env.NEXUSREP_VOICE_MIC_AFTER_GREETING || "1");
const WAIT_FOR_MIC_READY = !/^(0|false|no)$/i.test(process.env.NEXUSREP_VOICE_WAIT_FOR_MIC_READY || "1");
const VOICE_DRIVER = /^(file|fake-file)$/i.test(process.env.NEXUSREP_VOICE_DRIVER || "") ? "file" : "synthetic";
const TARGET = /^(launch|console)$/i.test(process.env.NEXUSREP_VOICE_TARGET || "") ? "launch" : "hcp";
const EDGE_EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BROWSER_EXECUTABLE = process.env.NEXUSREP_BROWSER_EXECUTABLE || (existsSync(EDGE_EXE) ? EDGE_EXE : "");
const QUESTIONS = (process.env.NEXUSREP_VOICE_QUESTIONS?.split("|").map((s) => s.trim()).filter(Boolean) ?? [
  "How does Milvexian work?",
  "What is the LIBREXIA program?",
  "How many phases are there in LIBREXIA?",
  "What is LIBREXIA stroke?",
  "How does it compare to Eliquis?",
  "A patient had bleeding while taking the study drug.",
]).slice(0, Math.max(1, Math.min(40, Number(process.env.NEXUSREP_VOICE_LIMIT || 6) || 6)));

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "nexusrep-voice-"));
  let browser;
  let conversationId = "";
  try {
    const audio = await buildQuestionAudio(dir, QUESTIONS);
    console.log(`audio=${audio.wavPath}`);
    console.log(`voiceDriver=${VOICE_DRIVER}`);
    console.log(`target=${TARGET}`);
    console.log(`questions=${JSON.stringify(QUESTIONS)}`);
    console.log(`schedule=startSilence:${START_SILENCE_SEC}s between:${BETWEEN_SEC}s endSilence:${END_SILENCE_SEC}s waitForMicReady:${WAIT_FOR_MIC_READY}`);

    browser = await chromium.launch({
      headless: true,
      ...(BROWSER_EXECUTABLE ? { executablePath: BROWSER_EXECUTABLE } : {}),
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        ...(VOICE_DRIVER === "file" ? [`--use-file-for-fake-audio-capture=${audio.wavPath}`] : []),
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const ctx = await browser.newContext({
      permissions: ["camera", "microphone"],
      viewport: { width: 1440, height: 900 },
    });
    await ctx.addInitScript(({ clipsBase64, betweenSec }) => {
      window.__nexusrepRecord = true;
      if (!clipsBase64?.length) return;
      const state = {
        ctx: null,
        destination: null,
        clips: null,
        started: false,
      };
      const bufferFromBase64 = (b64) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
      };
      const ensureAudio = async () => {
        if (!state.ctx) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          state.ctx = new AudioCtx();
          state.destination = state.ctx.createMediaStreamDestination();
        }
        if (state.ctx.state !== "running") await state.ctx.resume().catch(() => {});
        if (!state.clips) {
          state.clips = await Promise.all(clipsBase64.map((clip) => (
            state.ctx.decodeAudioData(bufferFromBase64(clip).slice(0))
          )));
        }
        return state;
      };
      const schedule = async () => {
        if (state.started) return;
        state.started = true;
        const s = await ensureAudio();
        let at = s.ctx.currentTime + Math.max(0, Number(window.__nexusrepVoiceStartSilenceSec || 0));
        for (const clip of s.clips) {
          const source = s.ctx.createBufferSource();
          source.buffer = clip;
          source.connect(s.destination);
          source.start(at);
          at += Math.max(clip.duration + 0.2, Number(betweenSec || 0));
        }
      };
      window.addEventListener("message", (event) => {
        if (event?.data?.type === "NEXUSREP_START_VOICE_SCRIPT") {
          window.__nexusrepVoiceStartSilenceSec = Number(event.data.startSilenceSec || 0);
          void schedule();
        }
      });
      if (navigator.mediaDevices?.getUserMedia && !navigator.mediaDevices.__nexusrepSyntheticMic) {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        Object.defineProperty(navigator.mediaDevices, "__nexusrepSyntheticMic", { value: true });
        navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
          const wantsAudio = constraints === true || Boolean(constraints.audio);
          const wantsVideo = constraints === true || Boolean(constraints.video);
          if (!wantsAudio) return original(constraints);
          const out = new MediaStream();
          if (wantsVideo) {
            try {
              const videoStream = await original({ video: constraints.video ?? true, audio: false });
              for (const track of videoStream.getVideoTracks()) out.addTrack(track);
            } catch {
              // Keep audio available even when a frame cannot acquire video.
            }
          }
          const s = await ensureAudio();
          for (const track of s.destination.stream.getAudioTracks()) out.addTrack(track);
          return out;
        };
      }
    }, VOICE_DRIVER === "synthetic" ? { clipsBase64: audio.clipsBase64, betweenSec: BETWEEN_SEC } : { clipsBase64: [], betweenSec: BETWEEN_SEC });

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

    await openTargetPreview(page);

    const session = await waitForSession(page);
    conversationId = conversationIdFromUrl(session.conversationUrl);
    console.log(`session=${session.sessionId}`);
    console.log(`conversation=${conversationId || "(unknown)"}`);

    await waitForLive(page);
    console.log("video=live");

    if (MIC_AFTER_GREETING) {
      const beforeGreetingStarts = await timingCount(page, "vendor_started_speaking");
      await waitForTimingAfter(page, "vendor_started_speaking", beforeGreetingStarts, 35_000)
        .catch(() => undefined);
      await sleep(2000);
    }

    const micOnAt = Date.now();
    await turnMicOn(page);
    console.log(`mic=on at ${new Date(micOnAt).toISOString()}`);
    if (VOICE_DRIVER === "synthetic") {
      await triggerSyntheticVoice(page);
      console.log("voice=started");
    }

    const durationMs = Math.round((START_SILENCE_SEC + QUESTIONS.length * BETWEEN_SEC + 6) * 1000 + RUN_EXTRA_MS);
    await sleep(durationMs);

    const detail = await loadSession(page, session.sessionId);
    const transcript = (detail?.turns || []).map((turn) => ({
      speaker: turn.speaker,
      text: String(turn.text || "").replace(/\s+/g, " ").trim(),
      slideId: turn.detailAidSlideId || null,
      route: turn.route || null,
      at: turn.at || null,
    }));
    const finalState = await page.evaluate(() => ({
      timingTail: (window.__nexusrepTiming || []).slice(-220),
      eventsTail: (window.__nexusrepEvents || []).slice(-80),
      visibleTextTail: document.body.innerText.slice(Math.max(0, document.body.innerText.length - 6000)),
    }));
    finalState.browserLatencyEvents = browserLatencyEvents;
    const analysis = analyzeVoiceRun(transcript, finalState, browserLatencyEvents);

    console.log("");
    console.log("JSON_SUMMARY_START");
    console.log(JSON.stringify({ session, conversationId, audio: audio.wavPath, voiceDriver: VOICE_DRIVER, schedule: { startSilenceSec: START_SILENCE_SEC, betweenSec: BETWEEN_SEC, endSilenceSec: END_SILENCE_SEC, waitForMicReady: WAIT_FOR_MIC_READY }, questions: QUESTIONS, analysis, transcript, finalState }, null, 2));
    console.log("JSON_SUMMARY_END");

    await ctx.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (conversationId) await endConversation(conversationId).catch((error) => {
      console.log(`endConversation failed: ${error.message}`);
    });
    if (!process.env.NEXUSREP_KEEP_VOICE_AUDIO) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildQuestionAudio(dir, questions) {
  const questionDir = join(dir, "clips");
  await writeFile(join(dir, "questions.json"), JSON.stringify(questions, null, 2));
  const ps1 = join(dir, "synth.ps1");
  await writeFile(ps1, `
param([string]$QuestionJson, [string]$OutDir)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$questions = Get-Content -LiteralPath $QuestionJson -Raw | ConvertFrom-Json
$i = 0
foreach ($q in $questions) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.Rate = -1
  $s.Volume = 100
  $out = Join-Path $OutDir ("q{0:D2}.wav" -f $i)
  $s.SetOutputToWaveFile($out)
  $s.Speak([string]$q)
  $s.Dispose()
  $i++
}
`, "utf8");
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, join(dir, "questions.json"), questionDir]);
  const clips = [];
  const clipsBase64 = [];
  for (let i = 0; i < questions.length; i += 1) {
    const p = join(questionDir, `q${String(i).padStart(2, "0")}.wav`);
    if (!existsSync(p)) throw new Error(`Speech synthesis did not create ${p}`);
    const buf = await readFile(p);
    clips.push(parseWav(buf));
    clipsBase64.push(buf.toString("base64"));
  }
  const fmt = clips[0].fmt;
  for (const clip of clips) {
    if (clip.fmt.audioFormat !== fmt.audioFormat || clip.fmt.numChannels !== fmt.numChannels || clip.fmt.sampleRate !== fmt.sampleRate || clip.fmt.bitsPerSample !== fmt.bitsPerSample) {
      throw new Error("Generated speech clips have mismatched WAV formats.");
    }
  }
  const silence = (sec) => Buffer.alloc(Math.round(fmt.byteRate * sec));
  const parts = [silence(START_SILENCE_SEC)];
  clips.forEach((clip, i) => {
    parts.push(clip.data);
    parts.push(silence(i === clips.length - 1 ? END_SILENCE_SEC : Math.max(0, BETWEEN_SEC - clip.durationSec)));
  });
  const out = resolve(join(dir, "hcp-questions.wav"));
  await writeWav(out, fmt, Buffer.concat(parts));
  return { wavPath: out, clipsBase64 };
}

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file.");
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        numChannels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        byteRate: buf.readUInt32LE(start + 8),
        blockAlign: buf.readUInt16LE(start + 12),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk.");
  return { fmt, data, durationSec: data.length / fmt.byteRate };
}

async function writeWav(path, fmt, data) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(fmt.audioFormat, 20);
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(fmt.byteRate, 28);
  header.writeUInt16LE(fmt.blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

async function turnMicOn(page) {
  if (WAIT_FOR_MIC_READY) {
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll("button")];
      const mic = buttons.find((button) => /turn microphone on/i.test(button.getAttribute("aria-label") || "") || (button.textContent || "").includes("🎤"));
      return Boolean(mic && !mic.disabled);
    }, undefined, { timeout: 60_000 });
  }
  const mic = page.locator('button[aria-label*="Turn microphone on"], button:has-text("🎤")').first();
  await mic.click({ timeout: 20_000 });
}

async function triggerSyntheticVoice(page) {
  await page.evaluate((startSilenceSec) => {
    const message = { type: "NEXUSREP_START_VOICE_SCRIPT", startSilenceSec };
    window.postMessage(message, "*");
    for (const frame of document.querySelectorAll("iframe")) {
      frame.contentWindow?.postMessage(message, "*");
    }
  }, START_SILENCE_SEC);
}

async function openTargetPreview(page) {
  if (TARGET === "hcp") {
    await page.goto(`${APP}/hcp`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: /Start session/i }).click({ timeout: 20_000 });
  } else {
    await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await ensureConsoleAuth(page);
    await page.getByText("Launch", { exact: true }).click({ timeout: 20_000 });
    await page.getByRole("button", { name: /Preview doctor view/i }).click({ timeout: 20_000 });
    await page.waitForURL(/\/hcp(?:\?|$)/, { timeout: 30_000 });
    await page.getByRole("button", { name: /Start session/i }).click({ timeout: 20_000 });
  }
  await page.waitForFunction(
    () => document.body.innerText.includes("GUIDED OVERVIEW") || document.body.innerText.includes("Video rep"),
    undefined,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: /Video rep/i }).click({ timeout: 20_000 });
}

async function ensureConsoleAuth(page) {
  await page.waitForFunction(
    () => !document.body.innerText.includes("Loading…"),
    undefined,
    { timeout: 30_000 },
  ).catch(() => undefined);
  if (!(await page.locator("text=Sign In").count())) return;
  const username = process.env.NEXUSREP_TEST_USER || "mahek";
  const password = process.env.NEXUSREP_TEST_PASSWORD || "mahek123";
  const inputs = page.locator("input");
  await inputs.nth(0).fill(username, { timeout: 20_000 });
  await inputs.nth(1).fill(password, { timeout: 20_000 });
  await page.getByRole("button", { name: /Sign In/i }).click({ timeout: 20_000 });
  await page.waitForFunction(
    () => document.body.innerText.includes("Launch") || document.body.innerText.includes("AI Rep Studio"),
    undefined,
    { timeout: 60_000 },
  );
}

async function timingCount(page, type) {
  return await page.evaluate((eventType) => (window.__nexusrepTiming || []).filter((event) => event.type === eventType).length, type);
}

async function waitForTimingAfter(page, type, before, timeoutMs) {
  await page.waitForFunction(
    ({ eventType, count }) => (window.__nexusrepTiming || []).filter((event) => event.type === eventType).length > count,
    { eventType: type, count: before },
    { timeout: timeoutMs },
  );
}

function analyzeVoiceRun(transcript, finalState, latencyEvents) {
  const hcpTurns = transcript.filter((t) => t.speaker === "hcp");
  const repTurns = transcript.filter((t) => t.speaker === "rep");
  const timings = finalState.timingTail || [];
  const starts = timings.filter((e) => e.type === "hcp_started_speaking").length;
  const stops = timings.filter((e) => e.type === "hcp_stopped_speaking").length;
  const finals = timings.filter((e) => e.type === "hcp_final_utterance").map((e) => e.text);
  const droppedCaptions = timings.filter((e) => e.type === "caption_drop").map((e) => ({ reason: e.reason, text: e.text }));
  return {
    hcpTurnCount: hcpTurns.length,
    repTurnCount: repTurns.length,
    hcpStarts: starts,
    hcpStops: stops,
    hcpFinals: finals,
    latencyEvents: latencyEvents.map((e) => ({
      question: e.question,
      asrMs: e.asrMs,
      partialCount: e.partialCount,
      transcriptToAudioMs: e.transcriptToAudioMs,
      finalVendorTextToAudioMs: e.finalVendorTextToAudioMs,
    })),
    droppedCaptions,
  };
}

async function waitForSession(page) {
  for (let i = 0; i < 100; i += 1) {
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
    { timeout: 100_000 },
  );
}

async function loadSession(page, sessionId) {
  return await page.evaluate(async (id) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json();
  }, sessionId);
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

async function run(cmd, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 1000)}`));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
