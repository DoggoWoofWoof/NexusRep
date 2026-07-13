/**
 * Durable, GLOBAL cache of rendered agent voice-preview clips — a JSON manifest committed to the
 * repo (public/agent-previews.json), keyed by `<replicaId>:<tone>` → a playable media URL. A clip
 * rendered ONCE (locally or on Render) is written here and cloned from GitHub, so it is never
 * regenerated in any environment (clean or seeded), and no Tavus credits are re-spent. The cache
 * is agent+tone scoped, deliberately independent of which brand/user is browsing.
 *
 * Server-only (uses node:fs). Best-effort: a read/write failure never breaks the preview route —
 * it just falls back to an in-process render + the stock clip.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const MANIFEST_PATH = resolve(process.cwd(), "public/agent-previews.json");
let mem: Record<string, string> | null = null; // this process's view of the manifest clips

async function load(): Promise<Record<string, string>> {
  if (mem) return mem;
  try {
    const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as { clips?: Record<string, string> };
    mem = parsed?.clips && typeof parsed.clips === "object" ? { ...parsed.clips } : {};
  } catch {
    mem = {};
  }
  return mem;
}

/** A previously-rendered clip URL for this agent+tone, or undefined. */
export async function getCachedPreview(key: string): Promise<string | undefined> {
  return (await load())[key];
}

/** Record a freshly-rendered clip URL — in memory for this process AND back to the committed
 *  manifest on disk (so `git add` captures it and every other environment reuses it). */
export async function putCachedPreview(key: string, url: string): Promise<void> {
  const clips = await load();
  if (clips[key] === url) return;
  clips[key] = url;
  try {
    let doc: { clips?: Record<string, string>; _note?: string } = {};
    try { doc = JSON.parse(await readFile(MANIFEST_PATH, "utf8")); } catch { /* new/empty manifest */ }
    doc.clips = { ...(doc.clips ?? {}), ...clips };
    await writeFile(MANIFEST_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");
  } catch {
    /* disk read-only (e.g. some hosts) — the in-memory copy still serves this process */
  }
}
