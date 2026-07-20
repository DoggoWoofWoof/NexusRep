/**
 * Per-HCP cross-session memory (@modules/hcpMemory) — the "context and memory per HCP on our side, not
 * relying on Tavus" the user asked for. Covers the pure distill/fold logic (idempotent, ordering-robust,
 * non-PII) AND the wired behaviour through the real container: a finished session is distilled into the
 * HCP's memory + audited, seeded history is backfilled, and a later session's follow-up carries the
 * prior-session context.
 */

import { describe, expect, it } from "vitest";
import { distillSession, foldMemory, buildRecap, type SessionFacts } from "@modules/hcpMemory";
import { asId, type HcpId, type SessionId } from "@lib/ids";
import { createContainer } from "@lib/container";
import type { GroundedComposer } from "@modules/content";

type Ctr = Awaited<ReturnType<typeof createContainer>>;
const sid = (s: string) => asId<"session_id">(s) as SessionId;
const hid = (s: string) => asId<"hcp_id">(s) as HcpId;

function factsOf(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionId: sid("session_a"),
    hcpId: hid("hcp_x"),
    at: "2026-07-01T10:00:00.000Z",
    topics: ["Mechanism of action"],
    intents: ["product_info"],
    routes: ["approved_answer"],
    requestedHuman: false,
    reportedAe: false,
    ...over,
  };
}

describe("hcpMemory — distill one session into non-PII facts", () => {
  it("pulls topics from served source ids (turns + audit), intents/routes from audit, and safety flags", async () => {
    const facts = await distillSession(
      {
        id: sid("session_1"),
        hcpId: hid("hcp_1"),
        startedAt: "2026-07-02T09:00:00.000Z",
        turns: [
          { speaker: "hcp", sourceIds: [] },
          { speaker: "rep", sourceIds: ["ans_moa"] },
          { speaker: "hcp", sourceIds: [] },
          { speaker: "rep", sourceIds: ["ans_program"] },
        ],
      },
      [
        { type: "classification", payload: { intent: "product_info" } },
        { type: "classification", payload: { intent: "dosing" } },
        { type: "response_output", payload: { route: "approved_answer", sourceIds: ["ans_moa"] } },
        { type: "response_output", payload: { route: "medical_information", sourceIds: [] } },
        { type: "follow_up_created", payload: { type: "human_rep" } },
      ],
      async (id) => ({ ans_moa: "Mechanism of action", ans_program: "LIBREXIA program" }[id]),
    );
    expect(facts.topics.sort()).toEqual(["LIBREXIA program", "Mechanism of action"]);
    expect(facts.intents.sort()).toEqual(["dosing", "product_info"]);
    expect(facts.routes.sort()).toEqual(["approved_answer", "medical_information"]);
    expect(facts.requestedHuman).toBe(true); // human_rep follow-up
    expect(facts.reportedAe).toBe(false);
  });

  it("flags an adverse event from the pharmacovigilance follow-up / AE route", async () => {
    const facts = await distillSession(
      { id: sid("s"), hcpId: hid("h"), startedAt: "2026-07-02T09:00:00.000Z", turns: [{ speaker: "hcp" }] },
      [{ type: "response_output", payload: { route: "adverse_event", sourceIds: [] } }],
      async () => undefined,
    );
    expect(facts.reportedAe).toBe(true);
  });
});

describe("hcpMemory — fold facts into a rolling memory", () => {
  it("creates memory on the first fold, with a recap", () => {
    const m = foldMemory(null, factsOf(), "2026-07-01T10:05:00.000Z");
    expect(m.hcpId).toBe("hcp_x");
    expect(m.id).toBe("hcp_x");
    expect(m.sessionIds).toEqual(["session_a"]);
    expect(m.topics[0]).toMatchObject({ topic: "Mechanism of action", count: 1 });
    expect(m.recap).toContain("1 prior session");
    expect(m.recap).toContain("Mechanism of action");
  });

  it("accumulates across sessions — counts, topic merge, last-session advance, sticky flags", () => {
    const m1 = foldMemory(null, factsOf({ sessionId: sid("s1"), at: "2026-07-01T10:00:00.000Z" }), "now");
    const m2 = foldMemory(
      m1,
      factsOf({ sessionId: sid("s2"), at: "2026-07-05T10:00:00.000Z", topics: ["Mechanism of action", "LIBREXIA program"], requestedHuman: true }),
      "now",
    );
    expect(m2.sessionIds).toEqual(["s1", "s2"]);
    expect(m2.topics.find((t) => t.topic === "Mechanism of action")?.count).toBe(2);
    expect(m2.topics.find((t) => t.topic === "LIBREXIA program")?.count).toBe(1);
    expect(m2.lastSessionId).toBe("s2");
    expect(m2.lastSessionAt).toBe("2026-07-05T10:00:00.000Z");
    expect(m2.everRequestedHuman).toBe(true);
    expect(m2.recap).toContain("2 prior sessions");
    expect(m2.recap).toContain("asked for a human rep");
  });

  it("is idempotent — folding the same session id twice is a no-op", () => {
    const m1 = foldMemory(null, factsOf({ sessionId: sid("dup") }), "now");
    const m2 = foldMemory(m1, factsOf({ sessionId: sid("dup") }), "now");
    expect(m2.sessionIds).toEqual(["dup"]);
    expect(m2.topics[0]?.count).toBe(1);
  });

  it("is ordering-robust — an OLDER session folded later does not move 'last session' back", () => {
    const newer = foldMemory(null, factsOf({ sessionId: sid("new"), at: "2026-07-10T10:00:00.000Z" }), "now");
    const withOlder = foldMemory(newer, factsOf({ sessionId: sid("old"), at: "2026-07-01T10:00:00.000Z" }), "now");
    expect(withOlder.lastSessionId).toBe("new");
    expect(withOlder.lastSessionAt).toBe("2026-07-10T10:00:00.000Z");
    expect(withOlder.sessionIds.sort()).toEqual(["new", "old"]);
  });

  it("buildRecap is empty when there is no history", () => {
    expect(buildRecap({ sessionIds: [], lastSessionAt: "", topics: [], everRequestedHuman: false, everReportedAe: false })).toBe("");
  });
});

describe("hcpMemory — wired through the container", () => {
  it("distills a finished session into the HCP's memory and audits it", async () => {
    const c = await createContainer();
    const hcpId = c.demo.hcpId;
    const s = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
    const before = (await c.hcpMemory.get(hcpId))?.sessionIds.length ?? 0;
    await c.conversation.turn({ sessionId: s.id, hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational, text: "What is Milvexian?" });
    await c.conversation.end(s.id, { durationSeconds: 30 });

    const mem = await c.hcpMemory.get(hcpId);
    expect(mem).toBeTruthy();
    expect(mem!.sessionIds).toContain(String(s.id));
    expect(mem!.sessionIds.length).toBe(before + 1);
    expect(mem!.recap).toContain("prior session");
    const trail = await c.audit.forSession(s.id);
    expect(trail.some((e) => e.type === "hcp_memory_updated")).toBe(true);
  });

  it("carries prior-session context onto a follow-up created in a LATER session", async () => {
    const c = await createContainer();
    const hcpId = c.demo.hcpId;
    const base = { hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational };

    // Session 1: a normal Q&A, then end → memory now holds this HCP's first session.
    const s1 = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
    await c.conversation.turn({ sessionId: s1.id, ...base, text: "What is Milvexian?" });
    await c.conversation.end(s1.id, { durationSeconds: 20 });

    // Session 2: a dosing question routes to Medical Information → a follow-up is created. It should carry
    // the prior-session recap resolved from memory at creation time.
    const s2 = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
    await c.conversation.turn({ sessionId: s2.id, ...base, text: "Can you tell me about the dosing?" });

    const fu = (await c.followups.list()).find((f) => String(f.sourceSessionId) === String(s2.id));
    expect(fu).toBeTruthy();
    expect(fu!.context).toBeTruthy();
    expect(fu!.context).toContain("prior session");
  });

  it("delivers the prior-session recap into the COMPOSER's guidance on the opening turn of a later session", async () => {
    // This is what makes the rep actually ANSWER with the context: the recap rides in the composer's
    // guidance (→ its system prompt). A stub composer captures the guidance it's handed, so we prove the
    // delivery without an LLM key. (With the real LLM composer this guidance becomes a brief spoken
    // continuity note; the deterministic no-LLM builder ignores guidance and stays verbatim.)
    const c = await createContainer();
    const hcpId = hid("hcp_mem_compose");
    const base = { hcpId, audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market, investigational: c.demo.investigational };
    const captured: string[][] = [];
    const stub: GroundedComposer = {
      name: "capture",
      available: () => true,
      compose: async ({ guidance }) => {
        captured.push(guidance ?? []);
        return { text: "Milvexian is an investigational, orally administered Factor XIa inhibitor being studied as an anticoagulant.", latencyMs: 1, truncated: false };
      },
    };
    const hasContinuity = (guides: string[][]) => guides.some((g) => g.some((s) => /prior session/i.test(s)));

    // Session 1 (first-ever contact): the opening turn's composer guidance must NOT mention prior sessions.
    const s1 = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
    await c.conversation.turn({ sessionId: s1.id, ...base, text: "What is Milvexian?" }, { composer: stub });
    expect(hasContinuity(captured)).toBe(false);
    await c.conversation.end(s1.id, { durationSeconds: 20 });

    // Session 2 (returning HCP): the opening turn's composer guidance now carries the prior-session recap.
    const mark = captured.length;
    const s2 = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
    await c.conversation.turn({ sessionId: s2.id, ...base, text: "What is Milvexian?" }, { composer: stub });
    const s2Guidance = captured.slice(mark);
    expect(hasContinuity(s2Guidance)).toBe(true);
    expect(s2Guidance.some((g) => g.some((s) => /Continuity/i.test(s) && /Previously covered/i.test(s)))).toBe(true);
  });

  it("backfills memory from seeded history so a returning HCP has context immediately", async () => {
    const c = await createContainer({ seedHistory: true });
    // hcp_sharma has a seeded Q&A session (the sibling recorded session is a PREVIEW — correctly excluded
    // from real HCP memory). So memory holds one real session, with the topics that were actually served.
    const mem = await c.hcpMemory.get(hid("hcp_sharma"));
    expect(mem).toBeTruthy();
    expect(mem!.sessionIds.length).toBeGreaterThanOrEqual(1);
    expect(mem!.topics.length).toBeGreaterThan(0); // topics resolved from the served approved answers
    expect(mem!.recap).toContain("prior session");
    expect(mem!.recap).toContain("covered");
  });
});
