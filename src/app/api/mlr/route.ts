/**
 * Thin controller for the MLR review loop. GET lists content awaiting review;
 * POST approves (→ active + published to retrieval) or rejects (→ retired) an
 * ingested answer. Logic lives in MlrService — nothing here decides eligibility.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const c = await getContainer();
  const pending = await c.mlr.listPending();
  const pendingSafety = await c.mlr.listPendingSafety();
  return NextResponse.json({
    pending: pending.map((a) => ({ id: a.id, topic: a.topic, preview: a.text.slice(0, 180), sourceFile: a.mlr.sourceFile, status: a.mlr.status })),
    pendingSafety: pendingSafety.map((s) => ({ id: s.id, preview: s.text.slice(0, 180), sourceFile: s.mlr.sourceFile, status: s.mlr.status, version: s.mlr.version })),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const body = (await req.json().catch(() => ({}))) as { action?: string; answerId?: unknown; safetyId?: unknown };
  const answerId = typeof body.answerId === "string" ? asId<"approved_answer_id">(body.answerId) : undefined;

  const c = await getContainer();
  const safetyId = typeof body.safetyId === "string" ? asId<"safety_statement_id">(body.safetyId) : undefined;
  if (safetyId) {
    const safety =
      body.action === "approve" ? await c.mlr.approveSafety(safetyId) : body.action === "reject" ? await c.mlr.rejectSafety(safetyId) : undefined;
    if (safety === undefined) return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
    if (!safety) return NextResponse.json({ error: "unknown safety statement" }, { status: 404 });
    return NextResponse.json({ id: safety.id, status: safety.mlr.status });
  }

  if (!answerId) return NextResponse.json({ error: "answerId or safetyId is required" }, { status: 400 });
  const answer =
    body.action === "approve" ? await c.mlr.approve(answerId) : body.action === "reject" ? await c.mlr.reject(answerId) : undefined;
  if (answer === undefined) return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
  if (!answer) return NextResponse.json({ error: "unknown answer" }, { status: 404 });
  return NextResponse.json({ id: answer.id, status: answer.mlr.status });
}
