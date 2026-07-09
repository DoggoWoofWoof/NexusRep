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

import { getContainer } from "@lib/container";
import { env } from "@lib/env";

export const dynamic = "force-dynamic";

interface ChatMessage { role: string; content: unknown }

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join(" ");
  return "";
}

export async function POST(req: Request): Promise<Response> {
  // Authenticate Tavus against the shared key we set in the persona's llm layer.
  if (env.tavusLlmKey) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${env.tavusLlmKey}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }

  const body = (await req.json().catch(() => ({}))) as { messages?: ChatMessage[]; stream?: boolean };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(lastUser?.content).trim();

  // Run the HCP turn through our compliance-gated orchestrator.
  let reply = "I can only share approved information. Let me connect you with someone who can help.";
  // Tavus fires a warm-up "connectivity check" at conversation start — answer it
  // so the check passes, but do NOT log it as an HCP turn (keeps the transcript clean).
  const isProbe = /connectivity check|automated .*check|test message/i.test(text);
  if (text && isProbe) {
    reply = "Connection confirmed.";
  } else if (text) {
    const c = await getContainer();
    // Gate ONLY — do not log turns here. The live video client (TavusStage) logs
    // the actual spoken utterances (both the doctor's ASR and the rep's reply) into
    // the call's own session, so logging here too would double every rep line.
    const output = await c.orchestrator.handleTurn({
      sessionId: c.demo.sessionId, // audit context only; transcript is client-logged
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text,
    });
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
