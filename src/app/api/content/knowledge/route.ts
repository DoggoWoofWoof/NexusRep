/**
 * First-party NexusRep Knowledge Base snapshot. Documents and chunks are the
 * canonical approved-content objects we own, not vendor KB state. Retrieval may
 * use a vector provider for candidate IDs, but this endpoint shows the source
 * documents/chunks that the compliance gate can validate.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const c = await getContainer();
  const [assets, answers, slides, safety] = await Promise.all([
    c.content.listAssets(),
    c.content.listAnswers(),
    c.content.listSlides(),
    c.content.listSafetyStatements(),
  ]);
  const slideById = new Map(slides.map((s) => [s.id, s]));

  const documents = assets.map((asset) => {
    const chunks = answers.filter((a) => a.contentAssetId === asset.id);
    const docSlides = slides.filter((s) => s.contentAssetId === asset.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    // The DOCUMENT's status is derived from its passages — the asset record keeps the
    // stamp it was ingested with ("in_mlr"), which goes stale the moment reviewers act:
    // any active passage -> active; any still pending -> in_mlr; all rejected -> rejected.
    const derivedStatus = chunks.some((a) => a.mlr.status === "active")
      ? "active"
      : chunks.some((a) => a.mlr.status === "in_mlr")
        ? "in_mlr"
        : chunks.length > 0 && chunks.every((a) => a.mlr.status === "retired" || a.mlr.status === "expired")
          ? "retired"
          : asset.mlr.status;
    return {
      id: asset.id,
      title: asset.title,
      kind: asset.kind,
      sourceFile: asset.mlr.sourceFile,
      status: derivedStatus,
      chunks: chunks.map((a) => ({
        id: a.id,
        topic: a.topic,
        status: a.mlr.status,
        sourceFile: a.mlr.sourceFile,
        slide: a.detailAidSlideId ? slideById.get(a.detailAidSlideId) ?? null : null,
        preview: a.text.slice(0, 220),
      })),
      slides: docSlides.map((s) => ({ id: s.id, title: s.title, label: s.label, position: s.position ?? null })),
    };
  });

  return NextResponse.json({
    provider: "nexusrep",
    documents,
    totals: {
      documents: documents.length,
      chunks: answers.length,
      activeChunks: answers.filter((a) => a.mlr.status === "active").length,
      pendingChunks: answers.filter((a) => a.mlr.status === "in_mlr").length,
      safetyStatements: safety.length,
      activeSafetyStatements: safety.filter((s) => s.mlr.status === "active").length,
    },
  });
}
