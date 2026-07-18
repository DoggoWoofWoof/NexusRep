/**
 * Realtime Arena streaming endpoint (SSE). Streams a provider's response token
 * by token and measures server-side time-to-first-token + total time. The client
 * speaks tokens as they arrive and can abort (interrupt) — aborting the fetch
 * fires `req.signal`, which stops the responder promptly.
 */

import { getResponder } from "@modules/realtime";
import { requireBrandUser } from "@lib/require-auth";

export async function POST(req: Request): Promise<Response> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const body = (await req.json().catch(() => ({}))) as { provider?: unknown; text?: unknown };
  const provider = typeof body.provider === "string" ? body.provider : "mock";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return new Response(JSON.stringify({ error: "text is required" }), { status: 400 });

  const responder = getResponder(provider);
  if (!responder || !responder.available()) {
    return new Response(JSON.stringify({ error: `provider '${provider}' not available` }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const t0 = Date.now();
  let ttft = -1;
  let chars = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const token of responder.stream(text, req.signal)) {
          if (req.signal.aborted) break;
          if (ttft < 0) ttft = Date.now() - t0;
          chars += token.length;
          send({ type: "token", t: token });
        }
        send({ type: "done", metrics: { ttftMs: ttft < 0 ? 0 : ttft, totalMs: Date.now() - t0, chars } });
      } catch (e) {
        console.error("[arena/stream]", e);
        send({ type: "error", message: "provider error — check the server logs" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
