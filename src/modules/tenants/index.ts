/**
 * Tenants / brands / campaigns (brief §16). Tenant isolation is a hard rule:
 * brand data, HCP lists, content, audit logs, CRM mappings, and exports are
 * isolated per tenant (PDF §11). Repositories should filter by tenant_id.
 */

import type { BrandId, CampaignId, TenantId } from "@lib/ids";

export interface Tenant {
  id: TenantId;
  name: string;
}

export interface Brand {
  id: BrandId;
  tenantId: TenantId;
  name: string;
}

export interface Campaign {
  id: CampaignId;
  tenantId: TenantId;
  brandId: BrandId;
  name: string;
  therapeuticArea: string;
  indication: string;
  market: string;
}

// TODO(stage 6): TenantService with per-tenant repository scoping.
