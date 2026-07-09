import { describe, expect, it } from "vitest";
import { asId, type SessionId } from "@lib/ids";
import { CrmOutbox } from "@modules/crm";
import { MockCrmAdapter } from "@modules/vendors/mock";

const session = asId<"session_id">("session_demo") as SessionId;

describe("CRM outbox", () => {
  it("enqueues an event as 'created'", async () => {
    const outbox = new CrmOutbox(new MockCrmAdapter());
    const entry = await outbox.enqueue(session, {
      eventType: "AI_DETAIL_COMPLETED",
      brandId: "b",
      campaignId: "c",
      sessionId: "s",
      hcpNpi: "1234567890",
    });
    expect(entry.status).toBe("created");
    expect(entry.attempts).toBe(0);
  });

  it("delivers an event with NPI as 'sent'", async () => {
    const outbox = new CrmOutbox(new MockCrmAdapter());
    const entry = await outbox.enqueue(session, {
      eventType: "AI_DETAIL_COMPLETED",
      brandId: "b",
      campaignId: "c",
      sessionId: "s",
      hcpNpi: "1234567890",
    });
    const delivered = await outbox.deliver(entry.id);
    expect(delivered?.status).toBe("sent");
    expect(delivered?.attempts).toBe(1);
  });

  it("flags a missing NPI as 'needs_mapping' (exception surfaced to UI)", async () => {
    const outbox = new CrmOutbox(new MockCrmAdapter());
    const entry = await outbox.enqueue(session, {
      eventType: "AI_DETAIL_COMPLETED",
      brandId: "b",
      campaignId: "c",
      sessionId: "s",
    });
    const delivered = await outbox.deliver(entry.id);
    expect(delivered?.status).toBe("needs_mapping");
  });
});
