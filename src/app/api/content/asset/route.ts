/**
 * Thin controller — remove an uploaded source document (and its parsed passages/slides)
 * from the library. The content module enforces the fail-safe: documents with ACTIVE
 * approved passages cannot be deleted — retire those through MLR reject first.
 */

import { NextResponse } from "next/server";
import { asId } from "@lib/ids";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request): Promise<NextResponse> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id.trim()) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const c = await getContainer();
  const result = await c.content.removeAsset(asId(id));
  if ("error" in result) return NextResponse.json(result, { status: 409 });
  await c.audit.record(c.demo.sessionId, "content_removed", { assetId: id, ...result.removed });
  return NextResponse.json(result);
}
