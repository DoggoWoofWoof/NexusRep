/**
 * Auth (brief §14 module list). Stub for Stage 1. Distinguishes the brand user
 * (full studio) from the HCP/doctor view (no internal surfaces). The doctor view
 * must never expose internal platform terms (hard rule, CLAUDE.md).
 */

import type { TenantId } from "@lib/ids";

export type Role = "brand_user" | "platform_admin" | "hcp";

export interface Principal {
  role: Role;
  tenantId?: TenantId;
}

// TODO(stage 6+): real auth/session. For now the app assumes a brand_user.
export const DEMO_BRAND_USER: Principal = { role: "brand_user" };
