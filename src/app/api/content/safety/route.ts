/**
 * Thin controller for ISI content governance. Brand users may draft revised ISI
 * wording here, but the HCP-facing runtime only uses an active MLR-approved
 * safety statement exactly as approved.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import type { MlrMetadata, SafetyStatement } from "@modules/content";
import { resolveBrandProfile, setupAnswersOf } from "@modules/brand";

export const dynamic = "force-dynamic";

function serialize(s: SafetyStatement | undefined | null) {
  return s
    ? {
        id: s.id,
        text: s.text,
        status: s.mlr.status,
        version: s.mlr.version,
        sourceFile: s.mlr.sourceFile,
      }
    : null;
}

function nextVersion(all: SafetyStatement[]): number {
  return Math.max(0, ...all.map((s) => s.mlr.version)) + 1;
}

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  const all = await c.content.listSafetyStatements();
  const active = await c.content.latestActiveSafetyStatement();
  const pending = all.filter((s) => s.mlr.status === "in_mlr").sort((a, b) => b.mlr.version - a.mlr.version);
  return NextResponse.json({
    active: serialize(active),
    pending: pending.map(serialize),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    text?: unknown;
    safetyId?: unknown;
  };
  const action = typeof body.action === "string" ? body.action : "";
  const c = await getContainer();

  if (action === "propose") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

    const all = await c.content.listSafetyStatements();
    const draft = (await c.studio.get(c.demo.aiRepId))?.draft;
    const clinical = resolveBrandProfile(c.brand, setupAnswersOf(draft)).clinical;
    const stamp = Date.now().toString(36);
    const mlr: MlrMetadata = {
      mlrApprovalId: asId<"mlr_approval_id">(`mlr_isi_${stamp}`),
      status: "in_mlr",
      version: nextVersion(all),
      audience: clinical.audience,
      indication: clinical.indication,
      market: clinical.market,
      expiresAt: null,
      sourceFile: "studio_isi_editor",
    };
    const safety: SafetyStatement = {
      id: asId<"safety_statement_id">(`isi_draft_${stamp}`),
      tenantId: c.demo.tenantId,
      brandId: c.demo.brandId,
      campaignId: c.demo.campaignId,
      text,
      mlr,
    };
    await c.content.addSafetyStatement(safety);
    return NextResponse.json({ pending: serialize(safety), status: safety.mlr.status });
  }

  const safetyId = typeof body.safetyId === "string" ? asId<"safety_statement_id">(body.safetyId) : undefined;
  if ((action === "approve" || action === "reject") && !safetyId) {
    return NextResponse.json({ error: "safetyId is required" }, { status: 400 });
  }

  if (action === "approve" && safetyId) {
    const safety = await c.mlr.approveSafety(safetyId);
    if (!safety) return NextResponse.json({ error: "unknown safety statement" }, { status: 404 });
    return NextResponse.json({ active: serialize(safety), status: safety.mlr.status });
  }
  if (action === "reject" && safetyId) {
    const safety = await c.mlr.rejectSafety(safetyId);
    if (!safety) return NextResponse.json({ error: "unknown safety statement" }, { status: 404 });
    return NextResponse.json({ rejected: serialize(safety), status: safety.mlr.status });
  }

  return NextResponse.json({ error: "action must be propose, approve, or reject" }, { status: 400 });
}
