/**
 * Thin controller — returns live analytics for all tabs, computed from the
 * session / follow-up / CRM / content / targeting stores. No business logic here.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";

export const dynamic = "force-dynamic";

const TAB_LABELS: { key: string; label: string }[] = [
  { key: "targeting", label: "Targeting" },
  { key: "engagement", label: "Engagement" },
  { key: "content", label: "Content" },
  { key: "compliance", label: "Compliance" },
  { key: "crm_ops", label: "CRM / Ops" },
  { key: "realtime_quality", label: "Realtime quality" },
];

export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const c = await getContainer();
  const [data, overview] = await Promise.all([c.analytics.all(), c.analytics.overview()]);
  return NextResponse.json({ tabs: TAB_LABELS, data, ...overview });
}
