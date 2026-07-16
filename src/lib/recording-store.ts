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
import { join } from "node:path";

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
 * Local-disk store: writes under public/recordings so Next serves it at /recordings/<file>. Durable
 * when running locally (the demo); on an ephemeral host (Render) the file is lost on redeploy — that's
 * the known tradeoff, and exactly why this is behind an interface (swap in S3/R2 for durability).
 */
class LocalDiskRecordingStore implements RecordingStore {
  readonly name = "local-disk";
  private readonly dir = join(process.cwd(), "public", "recordings");
  async save({ sessionId, bytes, contentType }: RecordingSaveInput): Promise<{ url: string }> {
    await mkdir(this.dir, { recursive: true });
    const file = `${fileBase(sessionId)}.${ext(contentType)}`;
    await writeFile(join(this.dir, file), bytes);
    return { url: `/recordings/${file}` };
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
