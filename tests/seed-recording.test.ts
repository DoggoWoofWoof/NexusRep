/**
 * The permanent "Preview (you)" demo session must play its video AND scrub in sync on every deploy.
 * This is the "verify the timestamps and stuff work" guard:
 *  - the clip is committed to the repo (so it reaches Render, unlike a runtime-captured clip),
 *  - the API route actually serves it,
 *  - the transcript is timelineSource:"recorded" and every turn's timestamp lands within the video
 *    (monotonic, inside [0, durationSeconds]) — so Session review places each turn at the right point.
 */

import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { createContainer } from "@lib/container";
import { asId } from "@lib/ids";
import { localRecordingPath } from "@lib/recording-store";
import { GET as serveRecording } from "@/app/api/recordings/[file]/route";

const PREVIEW_ID = asId<"session_id">("session_previewdemo1");
const CLIP = "demo-preview.webm";

describe("seeded preview recording — a permanent, in-sync demo video", () => {
  it("the committed clip exists on disk and is a real video (so it deploys + serves)", () => {
    const path = localRecordingPath(CLIP)!;
    expect(path).toBeTruthy();
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(1_000_000); // a real multi-minute clip, not a placeholder
  });

  it("the API route serves it (200 + video/webm)", async () => {
    const res = await serveRecording(new Request(`http://localhost/api/recordings/${CLIP}`), {
      params: Promise.resolve({ file: CLIP }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/video\/webm/);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(1_000_000);
  });

  it("the seeded session is a preview, recorded, and points at the served clip", async () => {
    const c = await createContainer({ seedHistory: true });
    const s = await c.sessions.get(PREVIEW_ID);
    expect(s).toBeTruthy();
    expect(s!.preview).toBe(true);
    expect(s!.timelineSource).toBe("recorded");
    expect(s!.recordingUrl).toBe(`/api/recordings/${CLIP}`);
    expect(s!.durationSeconds).toBeGreaterThan(0);
    expect(s!.turns.length).toBeGreaterThanOrEqual(6);
  });

  it("every turn timestamp lands within the video, in order — the review scrubs in sync", async () => {
    const c = await createContainer({ seedHistory: true });
    const s = (await c.sessions.get(PREVIEW_ID))!;
    const start = Date.parse(s.startedAt);
    const videoMs = s.durationSeconds * 1000;
    let prev = -1;
    for (const turn of s.turns) {
      expect(turn.at, "every recorded turn carries a timestamp").toBeTruthy();
      const offset = Date.parse(turn.at!) - start;
      expect(offset, `turn "${turn.text.slice(0, 30)}" starts at/after the video start`).toBeGreaterThanOrEqual(0);
      expect(offset, `turn "${turn.text.slice(0, 30)}" starts before the video ends`).toBeLessThanOrEqual(videoMs);
      expect(offset, "turns are monotonic (no time travel)").toBeGreaterThanOrEqual(prev);
      prev = offset;
    }
  });

  it("the preview does NOT inflate HCP engagement analytics (it's a brand self-test)", async () => {
    const c = await createContainer({ seedHistory: true });
    const a = await c.analytics.all();
    const all = await c.sessions.list();
    const real = all.filter((x) => !x.preview).length;
    expect(all.some((x) => x.preview)).toBe(true); // the preview is present…
    expect(a.engagement.find((m) => m.key === "sessions")?.value).toBe(String(real)); // …but not counted
  });
});
