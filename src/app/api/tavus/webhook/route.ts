/**
 * Tavus callback receiver. Tavus POSTs conversation lifecycle events here
 * (set as `callback_url` on conversation create). On `recording_ready` we attach
 * the playback URL to the matching session so it shows in Session-detail. The
 * event carries the `conversation_id`, which we linked to our session at create.
 */

import { NextResponse } from "next/server";
import { getContainer, getContainerForUser } from "@lib/container";
import { logServerActivity } from "@lib/activity-log";
import { verifyTavusWebhook } from "@lib/tavus-webhook-auth";
import { logger } from "@lib/logger";

const log = logger.child("tavus-webhook");

export const dynamic = "force-dynamic";

interface TavusCallback {
  event_type?: string;
  message_type?: string;
  conversation_id?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Pull the first recording URL/path from the known callback fields. */
function recordingUrl(body: TavusCallback): string | null {
  const p = body.properties ?? {};
  const candidates = [
    p.recording_url,
    p.storage_uri,
    p.url,
    p.download_url,
    p.s3_url,
    p.recording,
    body.recording_url,
    body.storage_uri,
    body.url,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && (/^https?:\/\//.test(v) || v.startsWith("/recordings/"))) return v;
  }
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  // Fail CLOSED: no key configured → refuse (was: skip the check → accept anyone). Auth is a per-owner
  // signature in ?k= (or the raw key via header) — never the master key in the URL. See
  // lib/tavus-webhook-auth. Without this, anyone who learned a conversation id could attach an
  // arbitrary recording URL to a session.
  const auth = verifyTavusWebhook(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const params = new URL(req.url).searchParams;
  // The container OWNER the conversation-start encoded on the callback URL. The recording lives in
  // that user's per-user store; loading the default container here would never find the session.
  const owner = params.get("u");
  const body = (await req.json().catch(() => ({}))) as TavusCallback;
  const event = String(body.event_type ?? body.message_type ?? "");
  const convId = body.conversation_id ?? (body.properties?.conversation_id as string | undefined);

  log.info("event", { event, conversationId: convId ?? null, owner: owner ?? null });
  // Feed the video lifecycle (replica_joined / pal_joined / shutdown / transcription_ready /
  // recording_ready) into the activity monitor so the operator sees the live call unfold.
  void logServerActivity({
    user: owner ?? "system",
    category: "video",
    action: `Tavus ${event || "event"}`,
    target: convId ?? undefined,
    severity: /shutdown|error|fail/i.test(event) ? "notice" : "info",
    metadata: { conversationId: convId, event },
  });

  if (convId && /recording_ready|recording\.ready/i.test(event)) {
    const url = recordingUrl(body);
    if (url) {
      // Reload the SAME container that owns the call's session (per-user when auth is on), so the
      // recording attaches to the session the operator actually sees — not the default store.
      const c = owner ? await getContainerForUser(owner) : await getContainer();
      const attached = await c.sessions.attachRecording(convId, url);
      if (!attached) {
        // Session lookup failed (e.g. store reset since the call) — say so instead of
        // claiming success. 200 keeps Tavus from retry-storming; the status is honest.
        log.error("recording_ready for unknown conversation", { conversationId: convId });
        return NextResponse.json({ ok: false, attached: false, error: "no matching session for conversation_id" });
      }
      return NextResponse.json({ ok: true, attached: true, sessionId: attached.id });
    }
    log.error("recording_ready without a recognizable recording URL", { conversationId: convId });
    return NextResponse.json({ ok: false, attached: false, error: "no recording url in payload" });
  }
  return NextResponse.json({ ok: true });
}
