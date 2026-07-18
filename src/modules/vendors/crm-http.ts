/**
 * Real CRM adapter — POSTs each canonical CrmEventPayload to a configured HTTP intake endpoint. Veeva
 * (Network/CRM) and Salesforce both accept inbound REST/webhook events, so a single generic HTTP
 * adapter covers both behind the swappable CrmAdapter interface (a vendor-specific field mapping can
 * layer on later without changing the outbox or the turn path). It NEVER sees a raw vendor payload —
 * only the canonical NexusRep event — and returns a canonical CrmDeliveryResult the outbox acts on.
 *
 * Retry lives in the outbox (CrmOutbox.flush), not here: transient failures (network, 429, 5xx) return
 * "retrying"; a hard 4xx returns "failed"; both are re-attempted with backoff up to the outbox's cap.
 */

import { logger } from "@lib/logger";
import type { CrmAdapter, CrmDeliveryResult, CrmEventPayload } from "./types";

export interface HttpCrmConfig {
  /** Adapter name surfaced in the UI (e.g. "veeva" / "salesforce") — never "mock". */
  name: string;
  url: string;
  token?: string;
  timeoutMs?: number;
}

export class HttpCrmAdapter implements CrmAdapter {
  readonly name: string;
  constructor(private readonly cfg: HttpCrmConfig) {
    this.name = cfg.name;
  }

  async deliver(payload: CrmEventPayload): Promise<CrmDeliveryResult> {
    // A follow-up can't be routed to the right rep/territory without the HCP's NPI — flag for mapping
    // (same contract as the mock) rather than POSTing an unroutable event.
    if (!payload.hcpNpi) return { status: "needs_mapping", detail: "missing hcp_npi mapping" };
    try {
      const res = await fetch(this.cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
      if (res.ok) return { status: "sent" };
      // 429 / 5xx are transient → retry through the outbox; other 4xx is a bad request → failed.
      if (res.status === 429 || res.status >= 500) return { status: "retrying", detail: `HTTP ${res.status}` };
      return { status: "failed", detail: `HTTP ${res.status}` };
    } catch (e) {
      const detail = e instanceof Error ? e.message : "network_error";
      logger.warn("CRM delivery failed (will retry via outbox)", { scope: "crm", vendor: this.name, detail });
      return { status: "retrying", detail };
    }
  }
}
