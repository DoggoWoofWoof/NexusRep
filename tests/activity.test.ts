/**
 * Activity log — the cross-user observability feed behind Admin → Activity. Covers the store
 * (record / query / filters / incremental sinceSeq / memory cap / never-throw) and the two routes
 * (client-beacon ingest with server-stamped identity + category clamping, and the filtered query).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { recordActivity, queryActivity, clearActivity } from "@modules/activity";
import { GET as queryRoute } from "@/app/api/activity/route";
import { POST as ingestRoute } from "@/app/api/activity/ingest/route";

describe("activity store", () => {
  beforeEach(() => clearActivity());

  it("records and returns newest-first with a global summary", () => {
    recordActivity({ user: "mahek", category: "content", action: "Uploaded content", target: "deck.pptx" });
    recordActivity({ user: "ashwin", category: "launch", action: "Launched invitations", severity: "notice" });
    const { events, summary } = queryActivity();
    expect(events.length).toBe(2);
    expect(events[0]!.action).toBe("Launched invitations"); // newest first
    expect(summary.total).toBe(2);
    expect(summary.users.sort()).toEqual(["ashwin", "mahek"]);
    expect(summary.byCategory.content).toBe(1);
    expect(summary.byCategory.launch).toBe(1);
  });

  it("filters by user / category / free-text and supports sinceSeq (incremental poll)", () => {
    const first = recordActivity({ user: "mahek", category: "click", action: "Clicked", target: "Launch" })!;
    recordActivity({ user: "ashwin", category: "api", action: "GET /api/sessions", target: "/api/sessions" });
    expect(queryActivity({ user: "mahek" }).events.length).toBe(1);
    expect(queryActivity({ category: "api" }).events.length).toBe(1);
    expect(queryActivity({ q: "launch" }).events.length).toBe(1); // matches target "Launch"
    expect(queryActivity({ q: "/api/sessions" }).events.length).toBe(1);
    // sinceSeq returns ONLY events newer than the cursor — the dashboard's live poll.
    expect(queryActivity({ sinceSeq: first.seq }).events.length).toBe(1);
    expect(queryActivity({ sinceSeq: first.seq }).events[0]!.category).toBe("api");
  });

  it("caps memory so the oldest events fall off", () => {
    for (let i = 0; i < 5200; i += 1) recordActivity({ category: "system", action: `e${i}` });
    expect(queryActivity().summary.total).toBeLessThanOrEqual(5000);
  });

  it("never throws on unserializable metadata (observability must not break flows)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => recordActivity({ category: "system", action: "x", metadata: circular })).not.toThrow();
  });
});

describe("activity routes", () => {
  beforeEach(() => clearActivity());

  it("ingests a client batch and the query route returns it filtered + summarized", async () => {
    const res = await ingestRoute(new Request("http://localhost/api/activity/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "brand",
        events: [
          { category: "click", action: "Clicked", target: "Start overview" },
          { category: "api", action: "GET /api/sessions", target: "/api/sessions", metadata: { status: 200, ms: 41 } },
        ],
      }),
    }));
    expect((await res.json()).accepted).toBe(2);

    const q = await queryRoute(new Request("http://localhost/api/activity?category=click"));
    const data = (await q.json()) as { events: { action: string }[]; summary: { total: number } };
    expect(data.events.length).toBe(1);
    expect(data.events[0]!.action).toBe("Clicked");
    expect(data.summary.total).toBeGreaterThanOrEqual(2);
  });

  it("stamps identity server-side (client can't spoof) and clamps an unknown category", async () => {
    await ingestRoute(new Request("http://localhost/api/activity/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "doctor", events: [{ category: "totally-bogus", action: "Clicked", user: "hacker" }] }),
    }));
    const { events } = queryActivity();
    expect(events[0]!.category).toBe("click"); // unknown category → safe default
    expect(events[0]!.user).toBe("doctor"); // no cookie + surface doctor → "doctor" (never the client-supplied "hacker")
    expect(events[0]!.surface).toBe("doctor");
  });
});
