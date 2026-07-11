/**
 * The "What HCPs are asking" mix and the compliance tiles are now MEASURED from the
 * audit trail (per-turn classification + compliance_decision), not hardcoded.
 */

import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";

describe("analytics: real topic distribution + measured compliance", () => {
  it("topic distribution reflects the intents of actual conversation turns", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const ask = (text: string) => c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text,
    });
    await ask("What is Milvexian and how does it work?");
    await ask("How does the mechanism work?");
    await ask("What is the clinical program studying?");

    const { total, slices } = await c.analytics.topicDistribution();
    expect(total).toBeGreaterThanOrEqual(3);          // every classified turn counted
    expect(slices.reduce((a, x) => a + x.count, 0)).toBe(total);
    expect(slices.every((x) => x.pct >= 0 && x.pct <= 100)).toBe(true);
    // Product/mechanism questions dominate this set.
    expect(slices[0]!.label).toMatch(/Product & mechanism|Clinical program/);
  });

  it("compliance counts are measured (grounded answers tracked, nothing ungrounded slipped)", async () => {
    const c = await createContainer();
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    await c.conversation.turn({
      sessionId: s.id, hcpId: c.demo.hcpId, audience: c.demo.audience,
      indication: c.demo.indication, market: c.demo.market,
      investigational: c.demo.investigational, text: "What is the clinical program studying?",
    });
    const cc = await c.analytics.complianceCounts();
    expect(cc.decisions).toBeGreaterThanOrEqual(1);
    expect(cc.grounded).toBeGreaterThanOrEqual(1);   // the approved answer carried a source
    expect(cc.ungroundedBlocked).toBe(0);            // gate let nothing ungrounded through
    expect(cc.unapprovedBlocked).toBe(0);
  });
});
