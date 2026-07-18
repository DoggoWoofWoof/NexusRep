/**
 * Real CRM adapter (HTTP) + outbox retry hardening + env-gated adapter selection.
 *  - HttpCrmAdapter maps HTTP outcomes → canonical CrmDeliveryResult (sent / retrying / failed /
 *    needs_mapping) and never POSTs an unroutable (no-NPI) event.
 *  - CrmOutbox.flush honors per-entry backoff and SUPPRESSES an entry after MAX_ATTEMPTS so a
 *    scheduled flush can't retry a permanently-failing delivery forever.
 *  - getCrmAdapter() uses the real adapter only when selected AND a URL is set, else the mock.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpCrmAdapter } from "@modules/vendors/crm-http";
import { CrmOutbox } from "@modules/crm";
import type { CrmAdapter, CrmDeliveryResult, CrmEventPayload } from "@modules/vendors";
import type { SessionId } from "@lib/ids";

const payload: CrmEventPayload = { eventType: "followup_msl", brandId: "b", campaignId: "c", sessionId: "s", hcpNpi: "1234567890" };

afterEach(() => vi.restoreAllMocks());

describe("HttpCrmAdapter", () => {
  it("POSTs the canonical event with auth and returns sent on 2xx", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const a = new HttpCrmAdapter({ name: "veeva", url: "https://crm.example/intake", token: "tok" });
    expect(await a.deliver(payload)).toEqual({ status: "sent" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://crm.example/intake");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toMatchObject({ eventType: "followup_msl", hcpNpi: "1234567890" });
  });

  it("returns needs_mapping (and never POSTs) when the event has no NPI", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await new HttpCrmAdapter({ name: "veeva", url: "u" }).deliver({ ...payload, hcpNpi: undefined });
    expect(r.status).toBe("needs_mapping");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 429/5xx → retrying (transient), other 4xx → failed, network error → retrying", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    expect((await new HttpCrmAdapter({ name: "v", url: "u" }).deliver(payload)).status).toBe("retrying");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
    expect((await new HttpCrmAdapter({ name: "v", url: "u" }).deliver(payload)).status).toBe("failed");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect((await new HttpCrmAdapter({ name: "v", url: "u" }).deliver(payload)).status).toBe("retrying");
  });
});

describe("CrmOutbox.flush — backoff + attempt cap", () => {
  const failing = (status: CrmDeliveryResult["status"]): CrmAdapter => ({ name: "x", deliver: async () => ({ status }) });

  it("honors per-entry backoff (skips a retry until it elapses)", async () => {
    const deliver = vi.fn(async () => ({ status: "retrying" as const }));
    const outbox = new CrmOutbox({ name: "x", deliver });
    await outbox.enqueue("s1" as SessionId, payload);
    await outbox.flush(1_000); // first attempt → sets a backoff a couple seconds out
    expect(deliver).toHaveBeenCalledTimes(1);
    await outbox.flush(1_500); // still within backoff → skipped
    expect(deliver).toHaveBeenCalledTimes(1);
    await outbox.flush(1_000_000); // well past backoff → retried
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("suppresses an entry after MAX_ATTEMPTS instead of retrying forever", async () => {
    const outbox = new CrmOutbox(failing("failed"));
    await outbox.enqueue("s1" as SessionId, payload);
    let now = 0;
    for (let i = 0; i < 15; i++) {
      now += 10 * 60_000; // advance past the max backoff each round
      await outbox.flush(now);
      if ((await outbox.list())[0]!.status === "suppressed") break;
    }
    const final = (await outbox.list())[0]!;
    expect(final.status).toBe("suppressed"); // terminal → future flushes skip it
    expect(final.attempts).toBeGreaterThanOrEqual(8);
  });
});

describe("getCrmAdapter — env-gated selection", () => {
  async function freshVendors(adapter?: string, url?: string) {
    vi.resetModules();
    if (adapter) process.env.NEXUSREP_CRM_ADAPTER = adapter; else delete process.env.NEXUSREP_CRM_ADAPTER;
    if (url) process.env.NEXUSREP_CRM_WEBHOOK_URL = url; else delete process.env.NEXUSREP_CRM_WEBHOOK_URL;
    return import("@modules/vendors");
  }
  afterEach(() => {
    delete process.env.NEXUSREP_CRM_ADAPTER;
    delete process.env.NEXUSREP_CRM_WEBHOOK_URL;
    vi.resetModules();
  });

  it("uses the real HTTP adapter only when a real adapter is selected AND a URL is set", async () => {
    expect((await freshVendors("veeva", "https://crm/intake")).getCrmAdapter().name).toBe("veeva");
    expect((await freshVendors("salesforce", "https://crm/intake")).getCrmAdapter().name).toBe("salesforce");
    // Selected but no URL → falls back to the mock rather than dropping every handoff silently.
    expect((await freshVendors("veeva", undefined)).getCrmAdapter().name).toBe("outbox-mock");
    // Default → mock.
    expect((await freshVendors(undefined, undefined)).getCrmAdapter().name).toBe("outbox-mock");
  });
});
