/**
 * Thin controller — live follow-up queue joined with CRM outbox status, shaped
 * for the Follow-ups surface. Derived from FollowUpService + CrmOutbox; the UI
 * only ever sees a status, never the raw payload. No business logic here.
 */

import { NextResponse } from "next/server";
import { requireBrandUser } from "@lib/require-auth";
import { getContainer } from "@lib/container";
import { hcpNameOf } from "@lib/demo-seed";
import type { FollowUpType } from "@modules/followups";
import type { CrmDeliveryStatus } from "@modules/vendors";

export const dynamic = "force-dynamic";

const REASON: Record<FollowUpType, string> = {
  msl: "MSL follow-up — clinical data request",
  medical_information: "Medical Information follow-up",
  pharmacovigilance: "Pharmacovigilance — adverse-event capture",
  human_rep: "Human rep callback requested",
};

const CRM_STATUS: Record<CrmDeliveryStatus, string> = {
  created: "Created",
  sent: "Sent to CRM",
  failed: "Failed",
  needs_mapping: "Needs mapping",
  retrying: "Retrying",
  suppressed: "Suppressed",
};

export async function GET(): Promise<NextResponse> {
  const _auth = await requireBrandUser();
  if (!_auth.ok) return _auth.res;
  const c = await getContainer();
  const [followups, outbox] = await Promise.all([c.followups.list(), c.crm.list()]);
  // Honest CRM label: show what is actually connected. A mock adapter is labeled as
  // simulated — never a vendor name ("Veeva") that isn't wired up.
  const target = /mock/i.test(c.crm.adapterName) ? "CRM (simulated)" : c.crm.adapterName;
  const rows = followups.map((f) => {
    const entry = outbox.find((e) => e.sessionId === f.sourceSessionId && e.payload.followUpType === f.type);
    return {
      id: f.id,
      // Resolve from the LIVE cohort first (DocNexus-backed ids), demo directory as fallback.
      hcp: c.targeting.get(String(f.hcpId))?.name ?? hcpNameOf(f.hcpId),
      reason: REASON[f.type],
      owner: f.owner,
      target,
      status: entry ? CRM_STATUS[entry.status] : "Created",
    };
  });
  return NextResponse.json({ rows });
}
