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
    expect(json.url).toMatch(/^\/recordings\//);
    expect((await c.sessions.get(s.id))?.recordingUrl).toBe(json.url);
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
