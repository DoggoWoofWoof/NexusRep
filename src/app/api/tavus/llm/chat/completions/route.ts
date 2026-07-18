/**
 * OpenAI-compatible chat-completions endpoint that Tavus's custom-LLM layer calls
 * (persona `layers.llm.base_url` → this app + "/chat/completions"). This is how
 * compliance is preserved when Tavus drives the avatar: Tavus sends the HCP's
 * transcribed turn here, we run it through the FULL orchestrator (classify →
 * route → grounding → compliance gate), and stream back ONLY the approved text.
 * Tavus's own model never composes an answer to an HCP.
 *
 * Responds with Server-Sent Events in the OpenAI streaming shape (Tavus requires
 * a streamable endpoint). Non-streaming requests get a normal completion object.
 */

import { asId } from "@lib/ids";
import { getContainer, getContainerForUser } from "@lib/container";
import { env } from "@lib/env";
import { logger } from "@lib/logger";
import { captureError } from "@lib/error-capture";
import { limited } from "@lib/rate-limit";
import { getActiveCall } from "@lib/active-call";
import { correctHcpAsrText } from "@lib/asr-correct";
import { beginLiveTurn, failLiveTurn, finishLiveTurn } from "@lib/live-turn-guard";
import {
  FRAGMENT_WINDOW_MS,
  mergeOrBufferFragment,
  shouldIgnoreTrailingRecoveredFragment,
  markRecoveredFragmentWindow,
  rememberRecoveredFragmentReply,
  waitForRecoveredFragmentReply,
} from "@modules/realtime";

export const dynamic = "force-dynamic";

interface ChatMessage { role: string; content: unknown }
interface TimingStep { name: string; dur: number; at: number }

function boundedMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? Math.max(min, Math.min(max, n)) : fallback;
}

const VOICE_CLASSIFIER_TIMEOUT_MS = boundedMs(process.env.NEXUSREP_TAVUS_CLASSIFIER_TIMEOUT_MS, 2400, 500, 6000);
const VOICE_COMPOSER_TIMEOUT_MS = boundedMs(process.env.NEXUSREP_TAVUS_COMPOSER_TIMEOUT_MS, 2500, 500, 7000);
const VOICE_COMPOSER_MAX_TOKENS = boundedMs(process.env.NEXUSREP_TAVUS_COMPOSER_MAX_TOKENS, 220, 80, 400);
const VOICE_STREAM_CHUNK_WORDS = boundedMs(process.env.NEXUSREP_TAVUS_STREAM_CHUNK_WORDS, 80, 3, 500);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ");
  return "";
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 96);
}

function stripUserAudioAnalysis(text: string): string {
  return text
    .replace(/<user_audio_analysis>[\s\S]*?<\/user_audio_analysis>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timingHeaders(timings: TimingStep[], extra?: Record<string, string>): HeadersInit {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const total = timings.length ? timings[timings.length - 1]!.at : 0;
  const compact = [...timings, { name: "total", dur: total, at: total }]
    .map((t) => `${safe(t.name)}=${Math.round(t.dur)}ms@${Math.round(t.at)}ms`)
    .join("; ");
  return {
    ...(extra ?? {}),
    "Server-Timing": timings.map((t) => `${safe(t.name)};dur=${Math.max(0, Math.round(t.dur))}`).join(", "),
    "X-NexusRep-Timing": compact,
  };
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  let lastMark = started;
  const timings: TimingStep[] = [];
  const mark = (name: string) => {
    const now = Date.now();
    timings.push({ name, dur: now - lastMark, at: now - started });
    lastMark = now;
  };
  // Authenticate Tavus against the shared key we set in the persona's llm layer.
  // The bearer is MANDATORY: without it this endpoint would hand out gated content and
  // log fake turns to anyone who finds the URL. No key configured -> refuse (fail safe),
  // never fall open. Set TAVUS_LLM_KEY wherever Tavus is deployed.
  if (!env.tavusLlmKey) {
    return new Response(JSON.stringify({ error: "TAVUS_LLM_KEY is not configured — refusing unauthenticated compliance traffic" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.tavusLlmKey}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  mark("auth");

  const body = (await req.json().catch(() => ({}))) as { messages?: ChatMessage[]; stream?: boolean };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let text = stripUserAudioAnalysis(textOf(lastUser?.content));
  mark("parse");
  const boundSessionId = req.headers.get("x-nexusrep-session-id")?.trim() || "";
  const boundUserId = req.headers.get("x-nexusrep-user-id")?.trim() || "";
  // Safety ceiling on the (bearer-authenticated) callback — keyed by SESSION, never IP (Tavus egress
  // IPs are shared). Deliberately generous so it can NEVER trip a live call's normal cadence (a turn
  // every few seconds); it only catches a runaway loop that would burn LLM credits.
  const limit = limited(req, "tavusCallback", boundSessionId || boundUserId || "default");
  if (limit) return limit;
  const boundCall = boundSessionId
    ? { sessionId: boundSessionId, userId: boundUserId && boundUserId !== "__default__" ? boundUserId : null }
    : null;

  // Run the HCP turn through our compliance-gated orchestrator.
  let reply = "I can only share approved information. Let me connect you with someone who can help.";
  // Per-turn diagnostic — logged so a real call can prove ISI cadence: whether every turn threads
  // the SAME session (sessionId stable across the call), and whether ISI was delivered this turn.
  // If ISI re-appears within one call, `isi` here shows true on >1 turn for the same sessionId.
  let turnInfo: Record<string, unknown> | undefined;
  let correctedPreview: string | undefined;
  let asrCorrections: [heard: string, snappedTo: string][] | undefined;
  // ASR silence/noise artifacts ("[BLANK_AUDIO]", "[inaudible]", …) are not speech — the
  // doctor said nothing. Answering them makes the agent reply to nobody and pollutes the
  // transcript with a fallback turn. Stay silent and log nothing.
  const isAsrArtifact = !text || /^\s*[[(]\s*(?:blank[_ ]?audio|inaudible|silence|no[_ ]?speech|noise|music|applause|laughter)\s*[\])]\s*$/i.test(text);
  // Tavus fires a warm-up "connectivity check" at conversation start — answer it
  // so the check passes, but do NOT log it as an HCP turn (keeps the transcript clean).
  const isProbe = /connectivity check|automated .*check|test message/i.test(text);
  if (isAsrArtifact) {
    reply = "";
  } else if (isProbe) {
    reply = "Connection confirmed.";
  } else {
    // The live call recorded WHICH per-user container owns its session. Tavus calls us without a
    // cookie, so we resolve the owner from the per-user LLM URL (/o/<owner> → x-nexusrep-user-id) and
    // look up THAT owner's active call — never a single global, so a concurrent second account's call
    // can't steer this turn into the wrong container.
    const activeCall = boundCall ?? getActiveCall(boundUserId || null);
    const sessionKey = activeCall?.sessionId ?? boundSessionId ?? "__default__";
    if (shouldIgnoreTrailingRecoveredFragment(sessionKey, text)) {
      // Tavus can call the LLM once for the recovered fragment ("What is the liberation,")
      // and immediately again for a tiny tail shard ("BRUE?"). If the empty shard returns first,
      // Tavus treats it as the newest turn and may drop the real answer. Hold the ignored shard
      // behind the normal live composer window. If the recovered answer is ready, replay that same
      // approved text to Tavus WITHOUT logging another NexusRep turn; otherwise stay silent.
      const replayWaitMs = Math.min(8000, Math.max(6000, VOICE_COMPOSER_TIMEOUT_MS + FRAGMENT_WINDOW_MS + 1500));
      const replay = await waitForRecoveredFragmentReply(sessionKey, replayWaitMs);
      reply = replay ?? "";
      mark(replay ? "fragment_replayed" : "fragment_ignored");
      turnInfo = {
        sessionId: activeCall?.sessionId ?? boundSessionId ?? null,
        activeCall: activeCall?.sessionId ?? null,
        owner: activeCall?.userId ?? null,
        binding: boundCall ? "url" : (activeCall ? "active_call" : "none"),
        route: replay ? "fragment_replayed" : "fragment_ignored",
        wallMs: Date.now() - started,
      };
    } else {
    const fragment = mergeOrBufferFragment(sessionKey, text);
    if (fragment.action === "buffer") {
      reply = "";
      mark("fragment_buffered");
      turnInfo = {
        sessionId: activeCall?.sessionId ?? boundSessionId ?? null,
        activeCall: activeCall?.sessionId ?? null,
        owner: activeCall?.userId ?? null,
        binding: boundCall ? "url" : (activeCall ? "active_call" : "none"),
        route: "fragment_buffered",
        wallMs: Date.now() - started,
      };
    } else {
    text = fragment.text;
    const c = activeCall ? await getContainerForUser(activeCall.userId) : await getContainer();
    mark("container");
    // Snap Tavus STT mis-hearings of the drug/program names to their canonical spelling BEFORE the
    // orchestrator classifies/retrieves — so "Lebrixia stock" is understood as "LIBREXIA STROKE"
    // and the doctor gets the right answer, not a mishandled one. Conservative (near-misses only).
    const correction = correctHcpAsrText(text, c.brand.persona.hotwords, c.brand.lexicon.productTerms);
    const correctedText = correction.text || text;
    correctedPreview = correctedText !== text ? previewText(correctedText) : undefined;
    asrCorrections = correction.corrections.length ? correction.corrections.slice(0, 4) : undefined;
    if (correction.corrections.some(([heard]) => /\bliberation\b/i.test(heard))) {
      markRecoveredFragmentWindow(sessionKey);
    }
    if (correctedText !== text) mark("asr_correct");
    // Tavus supplies ASR + avatar transport only. The actual turn goes through the same
    // ConversationService used by typed chat, so mic and chat share one NexusRep path:
    // log HCP turn -> orchestrate -> gate -> log rep turn/source/slide -> CRM/follow-up.
    let sessionId = asId<"session_id">(activeCall?.sessionId ?? (c.demo.sessionId as string));
    if (!(await c.sessions.get(sessionId))) {
      const fresh = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, seed: sessionId === c.demo.sessionId ? "demo" : undefined });
      sessionId = fresh.id;
    }
    // The call's session carries the invited doctor's identity (set at conversation create).
    const hcpId = (await c.sessions.get(sessionId))?.hcpId ?? c.demo.hcpId;
    mark("session");
    const guard = beginLiveTurn(String(sessionId), correctedText);
    if (guard.action === "drop") {
      reply = "";
      mark(`drop_${guard.reason}`);
      turnInfo = {
        sessionId,
        activeCall: activeCall?.sessionId ?? null,
        owner: activeCall?.userId ?? null,
        binding: boundCall ? "url" : (activeCall ? "active_call" : "none"),
        route: "duplicate_suppressed",
        duplicate: true,
        reason: guard.reason,
        ...(correctedPreview ? { correctedPreview } : {}),
        ...(asrCorrections ? { asrCorrections } : {}),
        wallMs: 0,
        budgets: { classifierMs: VOICE_CLASSIFIER_TIMEOUT_MS, composerMs: VOICE_COMPOSER_TIMEOUT_MS, composerMaxTokens: VOICE_COMPOSER_MAX_TOKENS },
      };
    } else {
    const beforeAudit = await c.audit.forSession(sessionId);
    const beforeSeq = beforeAudit.reduce((m, e) => Math.max(m, e.seq), -1);
    const turnWallStarted = Date.now();
    // Same compliance endpoint as typed chat: Tavus is only occupying an OpenAI-compatible
    // callback slot so it can ask NexusRep for the next script. It never composes content itself.
    // Voice gets tight LLM budgets; if classification/composition is slow, the orchestrator falls
    // back to keyword risk + deterministic approved copy instead of making the avatar wait.
    let output;
    try {
      const result = await c.conversation.turn({
        sessionId,
        hcpId,
        audience: c.demo.audience,
        indication: c.demo.indication,
        market: c.demo.market,
        investigational: c.demo.investigational,
        text: correctedText,
      }, {
        // Typed video turns are persisted by the HCP UI at the exact button-click time before
        // `conversation.respond` is dispatched. Reuse that pending HCP turn so Tavus callback
        // latency does not shift the durable replay timeline or double-count questions.
        reuseLatestHcpTurn: true,
        classificationTimeoutMs: VOICE_CLASSIFIER_TIMEOUT_MS,
        composerTimeoutMs: VOICE_COMPOSER_TIMEOUT_MS,
        composerMaxTokens: VOICE_COMPOSER_MAX_TOKENS,
        speculativeCompose: true,
        liveVoice: true,
        suppressRelatedSlide: true,
        coaching: [
          "Live video voice latency rule: be concise for spoken delivery, but do not drop a requested part of a multi-question turn just to be shorter. Answer each distinct question briefly. Do not recap the whole program, list every trial, or add optional next-slide offers unless the HCP explicitly asks for detail or to continue.",
        ],
      });
      output = result.output;
    } catch (error) {
      // The outer POST has no catch (Tavus gets a 500), so without this a live-turn orchestrator
      // failure left no structured signal. Capture it, then preserve the existing fail-turn + rethrow.
      captureError(error, { phase: "tavus-llm.turn", sessionId });
      failLiveTurn(guard.handle);
      throw error;
    }
    const finish = finishLiveTurn(guard.handle);
    const turnWallMs = Date.now() - turnWallStarted;
    const turnAudit = (await c.audit.forSession(sessionId)).filter((e) => e.seq > beforeSeq);
    const auditTimings = turnAudit
      .map((e) => ({
        type: e.type,
        action: typeof e.payload.action === "string" ? e.payload.action : undefined,
        latencyMs: typeof e.payload.latencyMs === "number" ? e.payload.latencyMs : undefined,
        wallMs: typeof e.payload.wallMs === "number" ? e.payload.wallMs : undefined,
        fallback: typeof e.payload.fallback === "string" ? e.payload.fallback : undefined,
      }))
      .filter((e) => e.latencyMs !== undefined || e.wallMs !== undefined || e.fallback);
    reply = finish.status === "current" ? output.responseText : "";
    if (
      reply &&
      finish.status === "current" &&
      (asrCorrections?.some(([heard]) => /\bliberation\b|\bbrue\b|\bbrew\b|\bbro\b/i.test(heard)) ||
        /\bLIBREXIA program\b/i.test(correctedPreview ?? ""))
    ) {
      rememberRecoveredFragmentReply(sessionKey, reply, VOICE_COMPOSER_TIMEOUT_MS);
    }
    mark(finish.status === "current" ? `turn_${output.route}` : "turn_superseded");
    turnInfo = {
      sessionId, // same across a call → session threads; changing → the bug that re-delivers ISI
      activeCall: activeCall?.sessionId ?? null, // null → fell back to demo (no live call registered)
      owner: activeCall?.userId ?? null, // which per-user container owns the call's session
      binding: boundCall ? "url" : (activeCall ? "active_call" : "none"),
      route: output.route,
      superseded: finish.status !== "current",
      ...(correctedPreview ? { correctedPreview } : {}),
      ...(asrCorrections ? { asrCorrections } : {}),
      isi: output.isiAttached, // true on more than one turn of the SAME sessionId = an ISI-repeat bug
      wallMs: turnWallMs,
      budgets: { classifierMs: VOICE_CLASSIFIER_TIMEOUT_MS, composerMs: VOICE_COMPOSER_TIMEOUT_MS, composerMaxTokens: VOICE_COMPOSER_MAX_TOKENS },
      auditTimings,
    };
    }
    }
    }
  }

  const created = Math.floor(Date.now() / 1000);
  const model = "nexusrep-compliance";
  if (isAsrArtifact || isProbe) mark(isAsrArtifact ? "ignored_asr_artifact" : "connectivity_probe");
  // Full HCP transcript + rep reply are logged verbatim on OUR side (intentional — see logger.ts;
  // the "no patient data to vendors" rule is enforced at the vendor boundary, not here).
  logger.child("tavus-llm").info("turn", {
    stream: body.stream !== false,
    inputChars: text.length,
    input: text,
    outputChars: reply.length,
    output: reply,
    totalMs: Date.now() - started,
    ...(turnInfo ? { turn: turnInfo } : {}),
    timings,
  });

  if (body.stream === false) {
    return Response.json({
      id: "chatcmpl-nexusrep",
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    }, { headers: timingHeaders(timings) });
  }

  const frame = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-nexusrep", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const words = reply.split(" ");
  const sseFrames = [frame({ role: "assistant" })];
  // The text is already final/gated before this response starts. A prebuilt SSE body gives the
  // tunnel/Tavus a finite response to consume immediately instead of holding a live stream open.
  for (let i = 0; i < words.length; i += VOICE_STREAM_CHUNK_WORDS) {
    const piece = words.slice(i, i + VOICE_STREAM_CHUNK_WORDS).join(" ") + (i + VOICE_STREAM_CHUNK_WORDS < words.length ? " " : "");
    sseFrames.push(frame({ content: piece }));
  }
  sseFrames.push(frame({}, "stop"), "data: [DONE]\n\n");
  const sseBody = sseFrames.join("");

  return new Response(sseBody, {
    headers: timingHeaders(timings, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Content-Length": String(new TextEncoder().encode(sseBody).length),
      Connection: "close",
    }),
  });
}
