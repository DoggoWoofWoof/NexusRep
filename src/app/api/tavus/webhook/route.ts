/**
 * Tavus callback receiver. Tavus POSTs conversation lifecycle events here
 * (set as `callback_url` on conversation create). On `recording_ready` we attach
 * the playback URL to the matching session so it shows in Session-detail. The
 * event carries the `conversation_id`, which we linked to our session at create.
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";

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
  const body = (await req.json().catch(() => ({}))) as TavusCallback;
  const event = String(body.event_type ?? body.message_type ?? "");
  const convId = body.conversation_id ?? (body.properties?.conversation_id as string | undefined);

  console.log("[tavus webhook]", event, convId ?? "(no conversation_id)");

  if (convId && /recording_ready|recording\.ready/i.test(event)) {
    const url = recordingUrl(body);
    if (url) {
      const c = await getContainer();
      const attached = await c.sessions.attachRecording(convId, url);
      if (!attached) {
        // Session lookup failed (e.g. store reset since the call) — say so instead of
        // claiming success. 200 keeps Tavus from retry-storming; the status is honest.
        console.error("[tavus webhook] recording_ready for unknown conversation:", convId);
        return NextResponse.json({ ok: false, attached: false, error: "no matching session for conversation_id" });
      }
      return NextResponse.json({ ok: true, attached: true, sessionId: attached.id });
    }
    console.error("[tavus webhook] recording_ready without a recognizable recording URL");
    return NextResponse.json({ ok: false, attached: false, error: "no recording url in payload" });
  }
  return NextResponse.json({ ok: true });
}
