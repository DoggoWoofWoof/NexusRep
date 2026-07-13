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
import { getContainer } from "@lib/container";
import { env } from "@lib/env";
import { getActiveCallSession } from "@lib/active-call";

export const dynamic = "force-dynamic";

interface ChatMessage { role: string; content: unknown }

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ");
  return "";
}

export async function POST(req: Request): Promise<Response> {
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

  const body = (await req.json().catch(() => ({}))) as { messages?: ChatMessage[]; stream?: boolean };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(lastUser?.content).trim();

  // Run the HCP turn through our compliance-gated orchestrator.
  let reply = "I can only share approved information. Let me connect you with someone who can help.";
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
    const c = await getContainer();
    // Tavus supplies ASR + avatar transport only. The actual turn goes through the same
    // ConversationService used by typed chat, so mic and chat share one NexusRep path:
    // log HCP turn -> orchestrate -> gate -> log rep turn/source/slide -> CRM/follow-up.
    let sessionId = asId<"session_id">(getActiveCallSession() ?? (c.demo.sessionId as string));
    if (!(await c.sessions.get(sessionId))) {
      const fresh = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, seed: sessionId === c.demo.sessionId ? "demo" : undefined });
      sessionId = fresh.id;
    }
    // The call's session carries the invited doctor's identity (set at conversation create).
    const hcpId = (await c.sessions.get(sessionId))?.hcpId ?? c.demo.hcpId;
    const { output } = await c.conversation.turn({
      sessionId,
      hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text,
    }, env.tavusComposeMode === "llm" ? undefined : { composer: null });
    reply = output.responseText;
  }

  const created = Math.floor(Date.now() / 1000);
  const model = "nexusrep-compliance";

  if (body.stream === false) {
    return Response.json({
      id: "chatcmpl-nexusrep",
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    });
  }

  // Stream the approved text as OpenAI SSE chunks (word-grouped so TTS can start early).
  const encoder = new TextEncoder();
  const frame = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-nexusrep", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ role: "assistant" })));
      const words = reply.split(" ");
      for (let i = 0; i < words.length; i += 6) {
        const piece = words.slice(i, i + 6).join(" ") + (i + 6 < words.length ? " " : "");
        controller.enqueue(encoder.encode(frame({ content: piece })));
      }
      controller.enqueue(encoder.encode(frame({}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
