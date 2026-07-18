/**
 * Streaming recording ingest. The browser records the replica with MediaRecorder in short timeslices
 * and POSTs each chunk here AS THE CALL HAPPENS (binary body; session id + 0-based seq in headers).
 * The store appends them into one growing WebM. Benefits over the whole-blob upload:
 *   - a clean "End video" only has to flush the LAST small chunk → finalizes in well under a second;
 *   - an abrupt tab-close still leaves everything up to the last chunk on disk (no all-or-nothing).
 * On the final chunk (x-nexusrep-final: 1) we attach the URL + duration to the session so Session
 * review can be honest when the recording is shorter than the transcript.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { getRecordingStore } from "@lib/recording-store";
import { logServerActivity } from "@lib/activity-log";

export const dynamic = "force-dynamic";

const MAX_CHUNK_BYTES = 20 * 1024 * 1024; // one timeslice is small; this only rejects a runaway chunk
const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // whole-recording ceiling (matches the whole-blob route)

export async function POST(req: Request): Promise<NextResponse> {
  const sessionIdRaw = req.headers.get("x-nexusrep-session-id") ?? "";
  if (!/^session_[a-z0-9_]+$/i.test(sessionIdRaw)) {
    return NextResponse.json({ ok: false, error: "missing or malformed session id" }, { status: 400 });
  }
  const seq = Number(req.headers.get("x-nexusrep-chunk-seq") ?? "");
  if (!Number.isInteger(seq) || seq < 0) {
    return NextResponse.json({ ok: false, error: "missing or malformed chunk seq" }, { status: 400 });
  }
  const isFinal = req.headers.get("x-nexusrep-final") === "1";
  const durationMs = Number(req.headers.get("x-nexusrep-duration-ms") ?? "");
  const contentType = (req.headers.get("content-type") ?? "video/webm").split(";")[0]!.trim();
  if (!/^video\/(webm|mp4)$/i.test(contentType)) {
    return NextResponse.json({ ok: false, error: "unsupported content type" }, { status: 415 });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_CHUNK_BYTES) {
    return NextResponse.json({ ok: false, error: "chunk too large" }, { status: 413 });
  }
  // A zero-byte non-final chunk is a harmless keep-alive; a zero-byte final still finalizes.
  if (bytes.byteLength === 0 && !isFinal) return NextResponse.json({ ok: true, skipped: "empty" });

  const c = await getContainer();
  const sessionId = asId<"session_id">(sessionIdRaw);
  if (!(await c.sessions.get(sessionId))) {
    console.warn(`[recording] chunk rejected: session ${sessionIdRaw} not in this account's container`);
    return NextResponse.json({ ok: false, error: "no such session in this account" }, { status: 404 });
  }

  const store = getRecordingStore();
  let url: string;
  let totalBytes: number;
  try {
    ({ url, totalBytes } = await store.appendChunk({ sessionId: sessionIdRaw, seq, bytes, contentType }));
  } catch (e) {
    console.error(`[recording] chunk append FAILED session=${sessionIdRaw} seq=${seq}:`, e);
    return NextResponse.json({ ok: false, error: "could not persist chunk" }, { status: 500 });
  }
  const overCap = totalBytes > MAX_TOTAL_BYTES;
  if (overCap) console.warn(`[recording] recording exceeded ${MAX_TOTAL_BYTES}B for ${sessionIdRaw} — finalizing early`);
  const finalizing = isFinal || overCap;

  // Attach the URL as soon as the recording EXISTS (first chunk) so an abruptly-ended session still
  // shows what streamed to disk; the final chunk (or the size cap) then adds the duration + logs done.
  if (seq === 0 || finalizing) {
    const attached = await c.sessions.setRecordingUrl(sessionId, url, finalizing && Number.isFinite(durationMs) ? durationMs : undefined);
    if (!attached) {
      console.error(`[recording] attach FAILED for ${sessionIdRaw} (saved to ${url})`);
      return NextResponse.json({ ok: false, error: "could not attach recording" }, { status: 500 });
    }
  }

  if (!finalizing) {
    return NextResponse.json({ ok: true, seq, totalBytes });
  }
  console.info(`[recording] finalized: session=${sessionIdRaw} url=${url} totalBytes=${totalBytes} durationMs=${Number.isFinite(durationMs) ? Math.round(durationMs) : "n/a"}`);
  void logServerActivity({
    category: "recording",
    action: "Recording finalized",
    target: url,
    sessionId: sessionIdRaw,
    metadata: { totalBytes, durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null, store: store.name, streamed: true },
  });
  return NextResponse.json({ ok: true, url, totalBytes, finalized: true });
}
