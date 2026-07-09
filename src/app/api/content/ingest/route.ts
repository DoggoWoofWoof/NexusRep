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
import { setupAnswersOf } from "@modules/brand";
import { llmComplete } from "@modules/content";
import { inferSetupAnswersFromDocument } from "@modules/setupAssistant";
import { extractSourceText, ingestSource, type RawSource } from "@modules/content";
import type { ContentAsset, MlrMetadata } from "@modules/content";

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
    /** Default true: infer setup answers (brand, indication, …) from the document. */
    autofillSetup?: unknown;
  };
  const filename = typeof body.filename === "string" ? body.filename : "";
  const b64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";
  if (!filename || !b64) return NextResponse.json({ error: "filename and contentBase64 are required" }, { status: 400 });
  // Cap the upload BEFORE decoding: ~10MB binary ≈ 14M base64 chars. An unbounded payload
  // could exhaust memory during Buffer.from().
  if (b64.length > 14_000_000) {
    return NextResponse.json({ error: "file too large (max ~10MB)" }, { status: 413 });
  }

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

  // Scope the parsed content to the brand's STABLE clinical context (audience / indication /
  // market). Deliberately NOT the chat-resolved values: the setup "target audience" answer is a
  // TARGETING preference (who to invite — e.g. "decile 2–4 whitespace cohort"), not an MLR
  // compliance label. Stamping free-text chat phrases here made uploads unretrievable the moment
  // the query context (stable clinical audience) no longer string-matched them.
  const c = await getContainer();
  const clinical = c.brand.clinical;
  const raw: RawSource = { kind, title, tenantId: c.demo.tenantId, brandId: c.demo.brandId, campaignId: c.demo.campaignId, text, mlr: draftMlr(filename, clinical) };
  // Brand lexicon improves topic inference for THIS brand's vocabulary (engine stays generic).
  const result = ingestSource(raw, `upload_${Date.now().toString(36)}`, { topicHints: c.brand.lexicon.topicSynonyms });

  // Store the parsed blocks as in-MLR content so they appear in the MLR review
  // queue (POST /api/mlr → approve). They are NOT indexed for retrieval yet, so
  // the rep cannot cite them until a reviewer approves.
  await c.content.addAsset(result.asset);
  for (const slide of result.slides) await c.content.addSlide(slide);
  for (const ans of result.answers) await c.content.addAnswer(ans);
  for (const safety of result.safety) await c.content.addSafetyStatement(safety);

  // Setup autofill: the document also ANSWERS setup questions (brand, indication, talking
  // points, hotwords…) — infer them so the brand user uploads once instead of typing each
  // answer. Fills BLANK fields only; anything the user already answered is untouched.
  let setupAutofill: { filled: string[]; values: Record<string, string> } | undefined;
  if (body.autofillSetup !== false && kind !== "isi") {
    try {
      const existing = setupAnswersOf((await c.studio.get(c.demo.aiRepId))?.draft);
      const inferred = await inferSetupAnswersFromDocument(text, existing, llmComplete);
      for (const [k, v] of Object.entries(inferred.filled)) {
        await c.studio.answer(c.demo.aiRepId, k, v);
      }
      if (Object.keys(inferred.filled).length) {
        setupAutofill = { filled: Object.keys(inferred.filled), values: inferred.filled };
      } else {
        console.warn("[ingest] setup autofill found nothing to fill (open keys already answered or extraction empty)", inferred.skipped);
      }
    } catch (e) {
      // Best-effort — the upload itself already succeeded — but say so, don't swallow.
      console.error("[ingest] setup autofill failed:", e instanceof Error ? e.message : e);
    }
  }

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
    ...(setupAutofill ? { setupAutofill } : {}),
    candidates: result.answers.map((a, i) => ({
      id: a.id,
      topic: a.topic,
      slide: result.slides[i]?.label ?? null,
      preview: a.text.slice(0, 180),
    })),
  });
}
