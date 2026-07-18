/** Provider availability for the in-chat model selector / A/B test. */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { listResponders } from "@modules/realtime";

export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  return NextResponse.json({ providers: listResponders() });
}
