/**
 * Thin controller for the agentic DocNexus Setup Assistant (brief §5). It gathers the current
 * setup state, optionally parses an attached document to plain text FOR CONTEXT (it does NOT
 * ingest — ingestion is a proposed action the user confirms, which then hits /api/content/ingest),
 * and asks the assistant module for one turn: a humanlike reply + proposed, unexecuted actions.
 *
 * All reasoning lives in @modules/setupAssistant; this only marshals I/O.
 * Accepts JSON: { message, history?, attachment?: { filename, contentBase64 } }.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";
import { setupAnswersOf } from "@modules/brand";
import { extractSourceText, llmComplete } from "@modules/content";
import { setupAssistantTurn, type SetupTurnInput } from "@modules/setupAssistant";

export const dynamic = "force-dynamic";

const MAX_HISTORY = 12;

export async function POST(req: Request): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const body = (await req.json().catch(() => ({}))) as {
    message?: unknown;
    history?: unknown;
    attachment?: { filename?: unknown; contentBase64?: unknown } | null;
  };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message && !body.attachment) {
    return NextResponse.json({ error: "message or attachment required" }, { status: 400 });
  }

  const history = Array.isArray(body.history)
    ? body.history
        .filter((m): m is { role: string; text: string } => Boolean(m) && typeof m === "object" && typeof (m as { text?: unknown }).text === "string")
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: String(m.text) }))
    : [];

  // Parse an attached document to text FOR CONTEXT only. Never ingested here — the user confirms
  // the ingest action, and the client then posts the same file to /api/content/ingest (which is the
  // one place that stores it, as in-MLR content that is not retrievable until a reviewer approves).
  let attachment: SetupTurnInput["attachment"] = null;
  const filename = typeof body.attachment?.filename === "string" ? body.attachment.filename : "";
  const b64 = typeof body.attachment?.contentBase64 === "string" ? body.attachment.contentBase64 : "";
  if (filename && b64) {
    if (b64.length > 14_000_000) {
      return NextResponse.json({ error: "file too large (max ~10MB)" }, { status: 413 });
    }
    try {
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const text = await extractSourceText(filename, bytes);
      attachment = { name: filename, text };
    } catch (e) {
      // A parse failure shouldn't kill the turn — the assistant can still talk and offer to retry.
      return NextResponse.json({ error: e instanceof Error ? e.message : "could not read that document" }, { status: 400 });
    }
  }

  const c = await getContainer();
  const known = setupAnswersOf((await c.studio.get(c.demo.aiRepId))?.draft);
  const hasIsi = Boolean((await c.content.latestActiveSafetyStatement())?.text?.trim());

  const turn = await setupAssistantTurn({ message, history, attachment, known, hasIsi }, llmComplete);
  return NextResponse.json(turn);
}
