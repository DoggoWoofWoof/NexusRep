/**
 * Receives a session recording the BROWSER captured (MediaRecorder on the replica stream) and
 * attaches it to the session. This is our recording path because Tavus's own recording is off on
 * this account (a conversation never returns a recording_url — verified via scripts/test-tavus-recording.mjs).
 *
 * The client POSTs the raw webm bytes (no base64 bloat) with the session id in a header. We store it
 * via the swappable RecordingStore (local disk now; S3/R2 later) and attach the URL to the session in
 * the SAME container the caller owns (getContainer() resolves the cookie → per-user, or default for a
 * public doctor link) — so the recording lands on the session the operator actually reviews.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { getRecordingStore } from "@lib/recording-store";

export const dynamic = "force-dynamic";

// Generous cap for a few-minute replica clip; rejects a runaway upload without buffering it.
const MAX_BYTES = 300 * 1024 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  const sessionIdRaw = req.headers.get("x-nexusrep-session-id") ?? "";
  if (!/^session_[a-z0-9_]+$/i.test(sessionIdRaw)) {
    return NextResponse.json({ ok: false, error: "missing or malformed session id" }, { status: 400 });
  }
  const contentType = (req.headers.get("content-type") ?? "video/webm").split(";")[0]!.trim();
  if (!/^video\/(webm|mp4)$/i.test(contentType)) {
    return NextResponse.json({ ok: false, error: "unsupported content type" }, { status: 415 });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared && declared > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "recording too large" }, { status: 413 });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return NextResponse.json({ ok: false, error: "empty recording" }, { status: 400 });
  if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ ok: false, error: "recording too large" }, { status: 413 });

  // Same container the caller owns → the recording attaches to the session they review.
  const c = await getContainer();
  const sessionId = asId<"session_id">(sessionIdRaw);
  if (!(await c.sessions.get(sessionId))) {
    console.warn(`[recording] upload rejected: session ${sessionIdRaw} not in this account's container`);
    return NextResponse.json({ ok: false, error: "no such session in this account" }, { status: 404 });
  }

  // Diagnostics: on Render this is how we confirm a clip actually saved + attached (the "video pane
  // shows but nothing loads" report). One [recording] line per step, greppable in the host logs.
  const store = getRecordingStore();
  console.info(`[recording] upload: session=${sessionIdRaw} bytes=${bytes.byteLength} type=${contentType} store=${store.name}`);
  let url: string;
  try {
    ({ url } = await store.save({ sessionId: sessionIdRaw, bytes, contentType }));
  } catch (e) {
    console.error(`[recording] SAVE FAILED for ${sessionIdRaw}:`, e);
    return NextResponse.json({ ok: false, error: "could not persist recording" }, { status: 500 });
  }
  const attached = await c.sessions.setRecordingUrl(sessionId, url);
  if (!attached) {
    console.error(`[recording] attach FAILED for ${sessionIdRaw} (saved to ${url})`);
    return NextResponse.json({ ok: false, error: "could not attach recording" }, { status: 500 });
  }
  console.info(`[recording] saved + attached: session=${sessionIdRaw} url=${url}`);

  await c.audit.record(sessionId, "response_output", { recording: url, bytes: bytes.byteLength, source: "client_capture" });
  return NextResponse.json({ ok: true, url });
}
