/** Provider availability for the in-chat model selector / A/B test. */

import { NextResponse } from "next/server";
import { listResponders } from "@modules/realtime";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ providers: listResponders() });
}
