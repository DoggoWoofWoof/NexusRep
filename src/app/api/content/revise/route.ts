/**
 * Thin controller — propose a REVISION of an active approved passage. The revision
 * lands in the MLR review queue as a new version; the current text stays live until
 * a reviewer approves it (approval retires the superseded version atomically).
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { answerId?: unknown; text?: unknown };
  const answerId = typeof body.answerId === "string" ? body.answerId.trim() : "";
  const text = typeof body.text === "string" ? body.text.slice(0, 4000) : "";
  if (!answerId || !text.trim()) return NextResponse.json({ error: "answerId and text are required" }, { status: 400 });

  const c = await getContainer();
  const result = await c.content.reviseAnswer(asId(answerId), text);
  if ("error" in result) return NextResponse.json(result, { status: 409 });
  await c.audit.record(c.demo.sessionId, "correction", { kind: "content_revision_proposed", revisionId: String(result.id), supersedes: answerId });
  return NextResponse.json({
    id: result.id,
    version: result.mlr.version,
    status: result.mlr.status,
    note: "Revision submitted to MLR review — the current approved text stays live until it's approved.",
  });
}
