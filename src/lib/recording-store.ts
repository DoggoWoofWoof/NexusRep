/**
 * Where a captured session recording (the replica clip the browser records with MediaRecorder) is
 * stored. Behind an interface so the demo can write to local disk today and a production deploy can
 * swap in a durable object store (S3 / Cloudflare R2) later WITHOUT touching the upload route or the
 * client — pick the impl in `getRecordingStore()`.
 *
 * Why client capture at all: Tavus's own recording is off on our account (verified — a conversation
 * never returns a recording_url), so we record the replica stream ourselves and attach it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

/** The writable directory recordings live in (under public/ so it survives a build, but we SERVE via
 *  an API route — see /api/recordings/[file] — because a runtime-written public/ file isn't reliably
 *  served in production/on Render). */
export const localRecordingsDir = (): string => join(process.cwd(), "public", "recordings");

/** Safe absolute path for a stored recording file, or null if the name is unsafe (traversal, etc.).
 *  Used by the streaming API route so serving never depends on Next's static public/ handling. */
export function localRecordingPath(file: string): string | null {
  const safe = basename(file);
  if (!safe || safe !== file || /[\\/]/.test(file)) return null;
  if (!/^[a-zA-Z0-9._-]+\.(webm|mp4)$/i.test(safe)) return null;
  return join(localRecordingsDir(), safe);
}

export interface RecordingSaveInput {
  /** Our session id — used to name the object so a session maps 1:1 to its clip. */
  sessionId: string;
  bytes: Uint8Array;
  /** e.g. "video/webm". */
  contentType: string;
}

export interface RecordingStore {
  readonly name: string;
  /** Persist the clip and return the URL the Session-review UI can play (<video src=…>). */
  save(input: RecordingSaveInput): Promise<{ url: string }>;
}

/** Safe object basename from a session id (no path traversal, stable per session). */
function fileBase(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "session";
  return `capture-${safe}`;
}

const ext = (contentType: string) => (/webm/i.test(contentType) ? "webm" : /mp4/i.test(contentType) ? "mp4" : "bin");

/**
 * Local-disk store: writes to public/recordings and returns an /api/recordings/<file> URL. We serve
 * through that API route rather than the static /recordings/ path because a file WRITTEN AT RUNTIME
 * isn't reliably served by `next start` (notably on Render), which showed the video pane loading
 * nothing. Durable while the host disk lives (the demo); on an ephemeral host it's lost on redeploy —
 * the known tradeoff, and why this is behind an interface (swap in S3/R2 for durability).
 */
class LocalDiskRecordingStore implements RecordingStore {
  readonly name = "local-disk";
  async save({ sessionId, bytes, contentType }: RecordingSaveInput): Promise<{ url: string }> {
    await mkdir(localRecordingsDir(), { recursive: true });
    const file = `${fileBase(sessionId)}.${ext(contentType)}`;
    await writeFile(join(localRecordingsDir(), file), bytes);
    return { url: `/api/recordings/${file}` };
  }
}

let cached: RecordingStore | null = null;

/**
 * The active recording store. Local disk by default. A production deploy sets NEXUSREP_RECORDING_STORE
 * (e.g. "s3") and this factory returns that adapter instead — the only place that changes when we add
 * durable storage; the upload route and client stay the same.
 */
export function getRecordingStore(): RecordingStore {
  if (cached) return cached;
  // Future: if (process.env.NEXUSREP_RECORDING_STORE === "s3") cached = new S3RecordingStore();
  cached = new LocalDiskRecordingStore();
  return cached;
}
