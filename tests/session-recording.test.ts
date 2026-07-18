/**
 * Client-side session recording + stray-preview cleanup.
 *  - /api/sessions/recording: the browser uploads the replica clip it captured (Tavus's own recording
 *    is off on our account), and we attach it to the session.
 *  - pruneStrayPreviews: clears ONLY empty brand-user previews (no recording, no real Q&A), and never
 *    an active/live call, a recorded session, one with questions, a real doctor session, or a recent one.
 */

import { describe, expect, it } from "vitest";
import { createContainer, getContainer } from "@lib/container";
import { POST as uploadRecording } from "@/app/api/sessions/recording/route";
import { POST as uploadChunk } from "@/app/api/sessions/recording/chunk/route";
import { GET as serveRecording } from "@/app/api/recordings/[file]/route";

describe("streaming recording upload (chunked, fast finalize)", () => {
  const chunkReq = (sessionId: string, seq: number, bytes: Uint8Array, extra: Record<string, string> = {}) =>
    uploadChunk(new Request("http://localhost/api/sessions/recording/chunk", {
      method: "POST",
      headers: { "content-type": "video/webm", "x-nexusrep-session-id": sessionId, "x-nexusrep-chunk-seq": String(seq), ...extra },
      body: bytes,
    }));

  it("appends chunks in order, attaches on chunk 0, sets duration on the final marker, and serves the concatenation", async () => {
    const c = await getContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, preview: true, seed: "stream_ok" });
    const sid = String(s.id);

    // Chunk 0 (carries the WebM header) → recording is attached IMMEDIATELY (survives an abrupt end).
    const c0 = await chunkReq(sid, 0, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
    expect(c0.status).toBe(200);
    expect((await c.sessions.get(s.id))?.recordingUrl).toMatch(/^\/api\/recordings\//);
    expect((await c.sessions.get(s.id))?.recordingDurationMs).toBeUndefined(); // not until finalize

    await chunkReq(sid, 1, new Uint8Array([4, 5, 6, 7]));

    // Final marker: empty body, sets the duration + finalizes.
    const fin = await chunkReq(sid, 2, new Uint8Array([]), { "x-nexusrep-final": "1", "x-nexusrep-duration-ms": "41000" });
    expect((await fin.json()).finalized).toBe(true);
    const sess = await c.sessions.get(s.id);
    expect(sess?.recordingDurationMs).toBe(41000);

    // Served bytes = chunk0 + chunk1 concatenated (the final empty marker adds nothing).
    const file = sess!.recordingUrl!.split("/").pop()!;
    const served = await serveRecording(new Request(`http://localhost${sess!.recordingUrl}`), { params: Promise.resolve({ file }) });
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7]));
  });

  it("rejects a malformed session id / seq", async () => {
    expect((await chunkReq("not-a-session", 0, new Uint8Array([1]))).status).toBe(400);
    const c = await getContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, preview: true, seed: "stream_badseq" });
    expect((await chunkReq(String(s.id), -1, new Uint8Array([1]))).status).toBe(400);
  });
});

describe("client-capture recording upload", () => {
  it("attaches the uploaded clip to the session so Session-review can play it", async () => {
    const c = await getContainer(); // the endpoint resolves this same (default, cookie-less) container
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, preview: true, seed: "upload_ok" });
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]); // tiny webm-ish blob
    const res = await uploadRecording(new Request("http://localhost/api/sessions/recording", {
      method: "POST",
      headers: { "content-type": "video/webm", "x-nexusrep-session-id": String(s.id) },
      body: bytes,
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; url: string };
    expect(json.ok).toBe(true);
    expect(json.url).toMatch(/^\/api\/recordings\//); // served via the API route, not static public/
    expect((await c.sessions.get(s.id))?.recordingUrl).toBe(json.url);
  });

  it("serves the uploaded clip back via /api/recordings/<file> (the reliable path on Render)", async () => {
    const c = await getContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, preview: true, seed: "serve_ok" });
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const up = await uploadRecording(new Request("http://localhost/api/sessions/recording", {
      method: "POST", headers: { "content-type": "video/webm", "x-nexusrep-session-id": String(s.id) }, body: bytes,
    }));
    const { url } = (await up.json()) as { url: string };
    const file = url.split("/").pop()!;
    const res = await serveRecording(new Request(`http://localhost${url}`), { params: Promise.resolve({ file }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/video\/webm/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("404s a missing recording and 400s a traversal name", async () => {
    const missing = await serveRecording(new Request("http://localhost/api/recordings/nope.webm"), { params: Promise.resolve({ file: "nope.webm" }) });
    expect(missing.status).toBe(404);
    const traversal = await serveRecording(new Request("http://localhost/api/recordings/x"), { params: Promise.resolve({ file: "../../secret.webm" }) });
    expect(traversal.status).toBe(400);
  });

  it("rejects a malformed session id and an empty body", async () => {
    const bad = await uploadRecording(new Request("http://localhost/api/sessions/recording", {
      method: "POST", headers: { "content-type": "video/webm", "x-nexusrep-session-id": "../etc/passwd" }, body: new Uint8Array([1]),
    }));
    expect(bad.status).toBe(400);
    const c = await getContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, seed: "upload_empty" });
    const empty = await uploadRecording(new Request("http://localhost/api/sessions/recording", {
      method: "POST", headers: { "content-type": "video/webm", "x-nexusrep-session-id": String(s.id) }, body: new Uint8Array(),
    }));
    expect(empty.status).toBe(400);
  });
});

describe("pruneStrayPreviews — only stray previews, never anything in use or real", () => {
  it("removes an empty old preview; keeps recorded / real-Q&A / real-doctor / recent", async () => {
    const c = await createContainer();
    const S = c.sessions;
    const rep = c.demo.aiRepId, hcp = c.demo.hcpId;
    const old = new Date(Date.now() - 30 * 60_000).toISOString();

    const stray = await S.start({ aiRepId: rep, hcpId: hcp, preview: true, startedAt: old, seed: "p_stray" });
    await S.appendTurn(stray.id, { speaker: "rep", text: "Hello, doctor.", at: old }); // greeting only → 0 questions
    const recorded = await S.start({ aiRepId: rep, hcpId: hcp, preview: true, startedAt: old, seed: "p_rec" });
    await S.setRecordingUrl(recorded.id, "/recordings/x.webm");
    const asked = await S.start({ aiRepId: rep, hcpId: hcp, preview: true, startedAt: old, seed: "p_asked" });
    await S.appendTurn(asked.id, { speaker: "hcp", text: "what is it?", at: old });
    const real = await S.start({ aiRepId: rep, hcpId: hcp, startedAt: old, seed: "p_real" }); // not a preview
    const recent = await S.start({ aiRepId: rep, hcpId: hcp, preview: true, seed: "p_recent" }); // recent, may be in use

    const removed = await S.pruneStrayPreviews({});
    expect(removed).toContain(String(stray.id));
    expect(removed).not.toEqual(expect.arrayContaining([String(recorded.id), String(asked.id), String(real.id), String(recent.id)]));
    expect(await S.get(stray.id)).toBeNull();
    expect(await S.get(recorded.id)).not.toBeNull();
    expect(await S.get(asked.id)).not.toBeNull();
    expect(await S.get(recent.id)).not.toBeNull();
  });

  it("never prunes the ACTIVE call, but prunes the just-ENDED empty preview even if recent", async () => {
    const c = await createContainer();
    const S = c.sessions;
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const active = await S.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, preview: true, startedAt: old, seed: "p_active" }); // old + empty → only the active guard protects it
    const endedRecent = await S.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId, preview: true, seed: "p_ended" }); // recent → only spared unless it's the ended one

    const removed = await S.pruneStrayPreviews({ activeSessionId: String(active.id), endedSessionId: String(endedRecent.id) });
    expect(removed).toContain(String(endedRecent.id));
    expect(removed).not.toContain(String(active.id));
    expect(await S.get(active.id)).not.toBeNull();
    expect(await S.get(endedRecent.id)).toBeNull();
  });
});
