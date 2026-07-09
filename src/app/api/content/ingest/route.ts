/**
 * Thin controller — parses an uploaded document (real .pptx / .txt / .md) into
 * candidate approved-content blocks for the Build flow. The parsed blocks come
 * back as DRAFT / in-MLR — they are NOT added to the live retrieval set and can
 * never be spoken until MLR approves them (hard rule: approved content only).
 *
 * Accepts JSON: { filename, contentBase64, kind?, title? }.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";
import { extractSourceText, ingestSource, type RawSource } from "@modules/content";
import type { ContentAsset, MlrMetadata } from "@modules/content";
import { resolveBrandProfile, setupAnswersOf } from "@modules/brand";

export const dynamic = "force-dynamic";

function draftMlr(sourceFile: string, clinical: { audience: string; indication: string; market: string }): MlrMetadata {
  return {
    mlrApprovalId: asId<"mlr_approval_id">("mlr_pending"),
    status: "in_mlr", // parsed content is NOT active — not retrievable until approved
    version: 1,
    audience: clinical.audience,
    indication: clinical.indication,
    market: clinical.market,
    expiresAt: null,
    sourceFile,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as {
    filename?: unknown;
    contentBase64?: unknown;
    kind?: unknown;
    title?: unknown;
  };
  const filename = typeof body.filename === "string" ? body.filename : "";
  const b64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
  if (!filename || !b64) return NextResponse.json({ error: "filename and contentBase64 are required" }, { status: 400 });

  let text: string;
  try {
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    text = await extractSourceText(filename, bytes);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "parse failed" }, { status: 400 });
  }

  // Infer the asset kind from the extension when the client didn't specify one, so a .pdf
  // upload is recorded as a pdf (not the "ppt" default).
  const lower = filename.toLowerCase();
  const inferredKind: ContentAsset["kind"] = lower.includes("isi") ? "isi" : lower.endsWith(".pdf") ? "pdf" : "ppt";
  const kind = (["ppt", "pdf", "script", "faq", "isi"] as const).includes(body.kind as never)
    ? (body.kind as ContentAsset["kind"])
    : inferredKind;
  const title = typeof body.title === "string" && body.title ? body.title : filename;

  // Scope the parsed content to the active brand's clinical context (audience / indication /
  // market) — resolved from the Setup Assistant's answers — so MLR filtering + retrieval match
  // whatever the brand user set by chatting, not a hardcoded value.
  const c = await getContainer();
  const draft = (await c.studio.get(c.demo.aiRepId))?.draft;
  const clinical = resolveBrandProfile(c.brand, setupAnswersOf(draft)).clinical;
  const raw: RawSource = { kind, title, tenantId: c.demo.tenantId, brandId: c.demo.brandId, campaignId: c.demo.campaignId, text, mlr: draftMlr(filename, clinical) };
  const result = ingestSource(raw, `upload_${Date.now().toString(36)}`);

  // Store the parsed blocks as in-MLR content so they appear in the MLR review
  // queue (POST /api/mlr → approve). They are NOT indexed for retrieval yet, so
  // the rep cannot cite them until a reviewer approves.
  await c.content.addAsset(result.asset);
  for (const slide of result.slides) await c.content.addSlide(slide);
  for (const ans of result.answers) await c.content.addAnswer(ans);
  for (const safety of result.safety) await c.content.addSafetyStatement(safety);

  // Return a review-ready summary. Nothing here is live until MLR sign-off.
  return NextResponse.json({
    filename,
    parsed: {
      slides: result.slides.length,
      blocks: result.answers.length,
      safetyStatements: result.safety.length,
    },
    status: "in_mlr",
    note: "Parsed content is pending MLR review and is not usable by the AI rep until approved.",
    candidates: result.answers.map((a, i) => ({
      id: a.id,
      topic: a.topic,
      slide: result.slides[i]?.label ?? null,
      preview: a.text.slice(0, 180),
    })),
  });
}
