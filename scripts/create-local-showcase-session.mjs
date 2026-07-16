/**
 * Creates a clean local showcase session without Tavus credits.
 *
 * Requires the dev server to be running. The script:
 * - clears local session/follow-up/audit/outbox rows through the dev-only route
 * - asks the real NexusRep APIs for a guided overview and routing cases
 * - writes a timestamped transcript sidecar
 * - creates a playable WebM whose timing matches the transcript offsets
 * - attaches that WebM to the exact session so Session review replays it
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL || "http://localhost:3000";
const PUBLIC_REC_DIR = join(ROOT, "public", "recordings");

const ROUTING_QUESTIONS = [
  "How does Milvexian work mechanistically?",
  "Tell me specifically about the LIBREXIA STROKE trial.",
  "Is Milvexian safer or better than apixaban?",
  "Can I use it off-label in pediatric patients?",
  "A patient had a serious bleeding event after receiving the study drug.",
  "Can a human representative contact me after this session?",
];

async function json(path, body) {
  const res = await fetch(`${APP}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data.error || text}`);
  return data;
}

function words(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function estDur(turn) {
  return Math.min(32, Math.max(2.5, words(turn.text).length * 0.42));
}

function timeline(detail) {
  const turns = detail.turns || [];
  const startMs = turns[0]?.at ? Date.parse(turns[0].at) : Date.parse(detail.session.startedAt);
  const offsets = [];
  for (let i = 0; i < turns.length; i += 1) {
    const at = turns[i].at ? Math.max(0, (Date.parse(turns[i].at) - startMs) / 1000) : 0;
    offsets[i] = i === 0 ? 0 : Math.max(at, offsets[i - 1] + estDur(turns[i - 1]));
  }
  const duration = (offsets[turns.length - 1] || 0) + (turns.length ? estDur(turns[turns.length - 1]) : 0);
  return { offsets, duration: Math.max(8, duration) };
}

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function transcriptText(detail, offsets) {
  const lines = [
    `${detail.session.hcp} - local showcase session`,
    `${detail.session.durationSeconds ? mmss(detail.session.durationSeconds) : mmss(offsets.at(-1) || 0)} - ${detail.turns.length} turns`,
    "",
  ];
  detail.turns.forEach((turn, index) => {
    lines.push(`[${mmss(offsets[index] || 0)}] ${turn.speaker === "hcp" ? "HCP" : "AI rep"}`);
    lines.push(turn.text);
    if (turn.detailAidSlideId) lines.push(`slide=${turn.detailAidSlideId}`);
    if (turn.sourceIds?.length) lines.push(`sources=${turn.sourceIds.join(", ")}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function makeWebm(detail, offsets, durationSec, outPath) {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(`<html><body style="margin:0;background:#071528"><canvas id="c" width="1280" height="720"></canvas></body></html>`);
    const b64 = await page.evaluate(
      async ({ detail, offsets, durationSec }) => {
        const canvas = document.getElementById("c");
        const ctx = canvas.getContext("2d");
        const turns = detail.turns || [];
        const wrap = (text, max) => {
          const out = [];
          let line = "";
          for (const word of String(text || "").split(/\s+/)) {
            if ((line + " " + word).trim().length > max) {
              if (line) out.push(line);
              line = word;
            } else {
              line = (line + " " + word).trim();
            }
          }
          if (line) out.push(line);
          return out.slice(0, 6);
        };
        const mmss = (seconds) => {
          const s = Math.max(0, Math.round(seconds));
          return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        };
        const activeIndex = (t) => {
          let idx = 0;
          for (let i = 0; i < offsets.length; i += 1) if (t >= offsets[i]) idx = i;
          return idx;
        };
        const draw = (t) => {
          const idx = activeIndex(t);
          const turn = turns[idx] || {};
          const rep = turn.speaker !== "hcp";
          const grad = ctx.createLinearGradient(0, 0, 1280, 720);
          grad.addColorStop(0, rep ? "#07172f" : "#0d2338");
          grad.addColorStop(1, rep ? "#123f7a" : "#164e63");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, 1280, 720);

          ctx.fillStyle = "rgba(255,255,255,.08)";
          ctx.beginPath();
          ctx.arc(1050, 120, 260 + Math.sin(t * 0.8) * 12, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = "#dbeafe";
          ctx.font = "700 34px Arial";
          ctx.fillText("NexusRep AI Rep Session", 74, 86);
          ctx.font = "600 18px Arial";
          ctx.fillStyle = rep ? "#93c5fd" : "#67e8f9";
          ctx.fillText(`${mmss(t)}  ${rep ? "AI rep speaking" : "HCP prompt"}`, 78, 126);

          ctx.fillStyle = "rgba(255,255,255,.12)";
          ctx.fillRect(76, 642, 1128, 10);
          ctx.fillStyle = rep ? "#60a5fa" : "#22d3ee";
          ctx.fillRect(76, 642, Math.min(1128, (t / durationSec) * 1128), 10);

          ctx.save();
          ctx.translate(190, 330);
          ctx.fillStyle = "rgba(15,23,42,.72)";
          ctx.beginPath();
          ctx.arc(0, 0, 130, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = rep ? "#bfdbfe" : "#a7f3d0";
          ctx.beginPath();
          ctx.arc(0, -36, 35, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(0, 58, 78, Math.PI, 0);
          ctx.fill();
          for (let i = 0; i < 5; i += 1) {
            const h = rep ? 28 + Math.sin(t * 5 + i) * 18 : 16;
            ctx.fillStyle = rep ? "#e0f2fe" : "#cbd5e1";
            ctx.fillRect(-58 + i * 29, 158 - h / 2, 12, h);
          }
          ctx.restore();

          ctx.fillStyle = "rgba(248,250,252,.94)";
          roundRect(ctx, 400, 210, 760, 288, 18);
          ctx.fill();
          ctx.fillStyle = rep ? "#0649ac" : "#0f766e";
          ctx.font = "700 18px Arial";
          ctx.fillText(rep ? "AI rep" : "Healthcare professional", 432, 254);
          ctx.fillStyle = "#172033";
          ctx.font = "400 29px Arial";
          wrap(turn.text || "", 58).forEach((line, i) => ctx.fillText(line, 432, 310 + i * 39));
          if (turn.detailAidSlideId) {
            ctx.fillStyle = "#64748b";
            ctx.font = "600 17px Arial";
            ctx.fillText(`Slide cue: ${turn.detailAidSlideId}`, 432, 470);
          }
        };
        function roundRect(ctx, x, y, w, h, r) {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.arcTo(x + w, y, x + w, y + h, r);
          ctx.arcTo(x + w, y + h, x, y + h, r);
          ctx.arcTo(x, y + h, x, y, r);
          ctx.arcTo(x, y, x + w, y, r);
          ctx.closePath();
        }

        const stream = canvas.captureStream(30);
        const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        rec.start(250);
        const start = performance.now();
        let raf;
        await new Promise((resolve) => {
          const frame = () => {
            const t = Math.min(durationSec, (performance.now() - start) / 1000);
            draw(t);
            if (t < durationSec) raf = requestAnimationFrame(frame);
            else resolve();
          };
          frame();
        });
        if (raf) cancelAnimationFrame(raf);
        await new Promise((resolve) => {
          rec.onstop = resolve;
          rec.stop();
        });
        const blob = new Blob(chunks, { type: mime });
        const buf = await blob.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      },
      { detail, offsets, durationSec },
    );
    writeFileSync(outPath, Buffer.from(b64, "base64"));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  mkdirSync(PUBLIC_REC_DIR, { recursive: true });
  console.log(`Using ${APP}`);
  await json("/api/dev/session-demo", { action: "clean" });

  const brand = await json("/api/brand").catch(() => ({}));
  const greeting = brand.greeting || "Hello, doctor. I'm an AI representative for Milvexian, an investigational compound from J&J. I can share publicly-available information and connect you with Medical Information for anything clinical.";

  console.log("Creating guided overview session...");
  const overview = await json("/api/presentation/overview", {
    newSession: true,
    greeting,
    text: "Can you walk me through the approved information?",
  });
  const sessionId = overview.sessionId;
  console.log(`Session: ${sessionId}`);

  for (const question of ROUTING_QUESTIONS) {
    console.log(`Asking: ${question}`);
    const out = await json("/api/conversation/turn", { sessionId, text: question });
    console.log(`  -> ${out.route}${out.detailAidSlideId ? ` / ${out.detailAidSlideId}` : ""}${out.followUp ? ` / follow-up:${out.followUp}` : ""}`);
  }

  let detail = await json(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const { offsets, duration } = timeline(detail);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const base = `nexusrep-local-showcase-${stamp}`;
  const webmPath = join(PUBLIC_REC_DIR, `${base}.webm`);
  const recordingUrl = `/recordings/${base}.webm`;

  console.log(`Generating ${Math.round(duration)}s local playback video...`);
  await makeWebm(detail, offsets, duration, webmPath);

  await json("/api/dev/session-demo", {
    action: "attachRecording",
    sessionId,
    recordingUrl,
    durationSeconds: Math.round(duration),
  });

  detail = await json(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const finalTimeline = timeline(detail);
  writeFileSync(join(PUBLIC_REC_DIR, `${base}.session.json`), `${JSON.stringify(detail, null, 2)}\n`);
  writeFileSync(join(PUBLIC_REC_DIR, `${base}.transcript.txt`), transcriptText(detail, finalTimeline.offsets));

  console.log("");
  console.log("DONE");
  console.log(`session=${sessionId}`);
  console.log(`recording=${recordingUrl}`);
  console.log(`transcript=/recordings/${base}.transcript.txt`);
  console.log(`turns=${detail.turns.length}`);
  console.log(`duration=${mmss(Math.round(finalTimeline.duration))}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
