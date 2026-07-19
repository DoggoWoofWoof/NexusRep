/**
 * Tavus recording_ready webhook — the "everything recorded except the video" bug. The recording
 * callback fires later, cookie-less, and must attach the playback URL to the SAME per-user container
 * the call's session lives in. Previously it used the default container and silently dropped the
 * recording on any auth-on (per-user) deploy. The conversation-start now encodes the owner on the
 * callback URL (?u=<user>); these lock that in.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@lib/env";
import { POST as tavusWebhook } from "@/app/api/tavus/webhook/route";
import { getContainerForUser } from "@lib/container";
import { tavusWebhookToken } from "@lib/tavus-webhook-auth";
import { clearActivity, queryActivity } from "@modules/activity";

const recordingReady = (convId: string, url: string) =>
  JSON.stringify({ event_type: "recording_ready", conversation_id: convId, properties: { recording_url: url } });

describe("Tavus recording webhook attaches the video to the OWNER's session", () => {
  beforeAll(() => { (env as { tavusLlmKey: string }).tavusLlmKey = "test-llm-key"; });
  afterAll(() => { (env as { tavusLlmKey: string }).tavusLlmKey = ""; });

  it("recording_ready with the owner param attaches to that user's per-user session", async () => {
    const user = "wh_rec_owner_a";
    const c = await getContainerForUser(user);
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.sessions.setVendorConversation(s.id, "conv_wh_a");

    const res = await tavusWebhook(new Request(`http://localhost/api/tavus/webhook?k=${tavusWebhookToken(user)}&u=${user}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: recordingReady("conv_wh_a", "https://cdn.example/rec_a.mp4"),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { attached?: boolean }).attached).toBe(true);
    const saved = await c.sessions.get(s.id);
    expect(saved?.recordingUrl).toBe("https://cdn.example/rec_a.mp4"); // the video now shows in Session review
  });

  it("without the owner param it can't find the per-user session (the dropped-recording bug)", async () => {
    const user = "wh_rec_owner_b";
    const c = await getContainerForUser(user);
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.sessions.setVendorConversation(s.id, "conv_wh_b");

    // No &u= → the webhook falls back to the default container, which doesn't hold this session.
    // (Signature is over the empty owner, matching a public-link callback.)
    const res = await tavusWebhook(new Request(`http://localhost/api/tavus/webhook?k=${tavusWebhookToken("")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: recordingReady("conv_wh_b", "https://cdn.example/rec_b.mp4"),
    }));
    expect(((await res.json()) as { attached?: boolean }).attached).toBe(false);
    expect((await c.sessions.get(s.id))?.recordingUrl).toBeUndefined();
  });

  it("a shutdown webhook records WHY the call ended on the session + a human activity line", async () => {
    const user = "wh_shutdown_a";
    const c = await getContainerForUser(user);
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.sessions.setVendorConversation(s.id, "conv_wh_shutdown");
    clearActivity();

    const res = await tavusWebhook(new Request(`http://localhost/api/tavus/webhook?k=${tavusWebhookToken(user)}&u=${user}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "system.shutdown", conversation_id: "conv_wh_shutdown", properties: { shutdown_reason: "participant_left_timeout" } }),
    }));
    expect(res.status).toBe(200);
    // The reason is stamped on the session (Session review can show it)…
    expect((await c.sessions.get(s.id))?.endReason).toBe("participant_left_timeout");
    // …and the admin Activity feed shows a HUMAN line linked to the session, not "Tavus system.shutdown".
    const { events } = queryActivity({ sessionId: String(s.id) });
    const shutdown = events.find((e) => e.action.startsWith("Video call ended"));
    expect(shutdown?.action).toBe("Video call ended — the doctor left / disconnected");
    expect(shutdown?.metadata?.reason).toBe("participant_left_timeout");
  });

  it("rejects a callback missing the shared key (401)", async () => {
    const res = await tavusWebhook(new Request(`http://localhost/api/tavus/webhook?u=whoever`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: recordingReady("conv_wh_x", "https://cdn.example/rec_x.mp4"),
    }));
    expect(res.status).toBe(401);
  });
});
