import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@lib/env";
import { TavusRealtimeProvider } from "@modules/vendors";
import { getRealtimeProvider } from "@modules/vendors";
import { POST as llmCompletions } from "@/app/api/tavus/llm/chat/completions/route";

afterEach(() => vi.unstubAllGlobals());

/** Collect the assistant content from an OpenAI SSE stream Response. */
async function readSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value);
  }
  let content = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: ") && !line.includes("[DONE]")) {
      try {
        const j = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
        content += j.choices?.[0]?.delta?.content ?? "";
      } catch {
        /* ignore keep-alive lines */
      }
    }
  }
  return content;
}

describe("Tavus realtime adapter", () => {
  it("falls back to the mock provider when no key is configured", () => {
    // Test env has no TAVUS_API_KEY.
    expect(getRealtimeProvider().name).toBe("mock");
  });

  it("creates a persona wired to our custom-LLM endpoint, then a conversation, and returns the join URL", async () => {
    const calls: { url: string; method?: string; body: Record<string, unknown> | null }[] = [];
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/personas")) return new Response(JSON.stringify({ persona_id: "p1" }), { status: 200 });
      if (u.endsWith("/end")) return new Response("{}", { status: 200 });
      if (u.endsWith("/conversations")) return new Response(JSON.stringify({ conversation_id: "c1", conversation_url: "https://tavus.daily.co/c1", status: "active" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    const session = await tavus.startSession({
      sessionId: "hcp-1",
      systemPrompt: "sp",
      tools: [{ name: "route_to_msl", description: "route", parameters: { type: "object", properties: {} } }],
      customGreeting: "hi doctor",
      customLlm: { baseUrl: "https://app.example/api/tavus/llm", model: "nexusrep-compliance" },
      agentId: "r1",
    });

    expect(session.provider).toBe("tavus");
    expect(session.transportUrl).toBe("https://tavus.daily.co/c1");

    const persona = calls.find((c) => c.url.endsWith("/personas"))!;
    const llmLayer = (persona.body?.layers as { llm?: { base_url?: string; tools?: unknown[] } })?.llm;
    expect(llmLayer?.base_url).toBe("https://app.example/api/tavus/llm"); // our compliance endpoint drives replies
    expect(llmLayer?.tools?.length).toBe(1);

    const convo = calls.find((c) => c.url.endsWith("/conversations"))!;
    expect(convo.body?.persona_id).toBe("p1");
    expect(convo.body?.replica_id).toBe("r1");
    expect(convo.body?.custom_greeting).toBe("hi doctor");
    expect((convo.body?.properties as { enable_closed_captions?: boolean } | undefined)?.enable_closed_captions).toBe(false);

    await tavus.endSession();
    expect(calls.some((c) => c.url.endsWith("/end"))).toBe(true);
  });
});

describe("Tavus custom-LLM endpoint preserves the compliance gate", () => {
  // The bearer is MANDATORY now (audit fix: an unset key must fail CLOSED, not open).
  // Give the route a key for the gated-reply tests and authenticate like Tavus does.
  beforeAll(() => {
    (env as { tavusLlmKey: string }).tavusLlmKey = "test-llm-key";
  });
  afterAll(() => {
    (env as { tavusLlmKey: string }).tavusLlmKey = "";
  });
  const call = (userText: string, auth: string | null = "Bearer test-llm-key") =>
    llmCompletions(new Request("http://localhost/api/tavus/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: userText }], stream: true }),
    }));

  it("refuses unauthenticated calls (401), and refuses when no key is configured at all", async () => {
    expect((await call("What is Milvexian?", null)).status).toBe(401);
    expect((await call("What is Milvexian?", "Bearer wrong-key")).status).toBe(401);
    const saved = (env as { tavusLlmKey: string }).tavusLlmKey;
    (env as { tavusLlmKey: string }).tavusLlmKey = "";
    try {
      // No key configured -> fail CLOSED (this used to skip the check entirely).
      expect((await call("What is Milvexian?", null)).status).toBe(401);
    } finally {
      (env as { tavusLlmKey: string }).tavusLlmKey = saved;
    }
  });

  it("answers a public product-info question with approved text", async () => {
    const content = (await readSse(await call("What is Milvexian and how does it work?"))).toLowerCase();
    expect(content).toMatch(/investigational|factor xia|librexia/);
  });

  it("routes a dosing question to Medical Information, never a fabricated dose", async () => {
    const content = (await readSse(await call("What is the recommended dose and titration?"))).toLowerCase();
    expect(content).toContain("medical information");
    expect(content).not.toMatch(/\bmg\b|milligram/);
  });
});

// ── Concurrency hygiene: previews must end their conversation + self-heal the cap ──
describe("Tavus conversation cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("endConversation POSTs /conversations/{id}/end", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    await tavus.endConversation("c-123");
    expect(calls.some((c) => c === "POST https://tavusapi.com/v2/conversations/c-123/end")).toBe(true);
  });

  it("endActiveConversations lists active + ends each, returns the count", async () => {
    const ended: string[] = [];
    vi.stubGlobal("fetch", (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/conversations?status=active")) {
        return new Response(JSON.stringify({ data: [{ conversation_id: "c1", status: "active" }, { conversation_id: "c2", status: "active" }] }), { status: 200 });
      }
      const m = u.match(/\/conversations\/(c\d)\/end$/);
      if (m) { ended.push(m[1]!); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    const n = await tavus.endActiveConversations();
    expect(n).toBe(2);
    expect(ended.sort()).toEqual(["c1", "c2"]);
  });

  it("endActiveConversations fails safe to 0 when listing errors", async () => {
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as typeof fetch);
    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    expect(await tavus.endActiveConversations()).toBe(0);
  });
});

// ── Agent gallery: list stock + personal agents, start training a new one ──
describe("Tavus agent catalog (vendor replicas -> canonical AgentSummary)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("listAgents merges personal + stock lists, maps status, dedupes by id", async () => {
    vi.stubGlobal("fetch", (async (url: string) => {
      const u = String(url);
      if (u.includes("replica_type=system")) {
        return new Response(JSON.stringify({ data: [
          { replica_id: "rs1", replica_name: "Nora", status: "completed", thumbnail_video_url: "https://cdn/nora.mp4" },
          { replica_id: "rp1", replica_name: "Duplicate of mine", status: "completed" },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [
        { replica_id: "rp1", replica_name: "Our presenter", status: "training", replica_type: "user" },
      ] }), { status: 200 });
    }) as typeof fetch);
    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    const list = await tavus.listAgents();
    expect(list).toHaveLength(2); // rp1 deduped — the personal record wins
    const mine = list.find((r) => r.id === "rp1")!;
    expect(mine).toMatchObject({ kind: "personal", status: "training", name: "Our presenter" });
    const nora = list.find((r) => r.id === "rs1")!;
    expect(nora).toMatchObject({ kind: "stock", status: "ready", thumbnailUrl: "https://cdn/nora.mp4" });
  });

  it("listAgents survives one list failing (returns the other)", async () => {
    vi.stubGlobal("fetch", (async (url: string) => {
      if (String(url).includes("replica_type=system")) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ data: [{ replica_id: "rp1", replica_name: "Mine", status: "completed" }] }), { status: 200 });
    }) as typeof fetch);
    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    const list = await tavus.listAgents();
    expect(list.map((r) => r.id)).toEqual(["rp1"]);
  });

  it("createAgent POSTs name + train video and returns a training summary", async () => {
    let sent: unknown = null;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/replicas") && init?.method === "POST") {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ replica_id: "rnew1", status: "training" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    const tavus = new TavusRealtimeProvider({ apiKey: "k", baseUrl: "https://tavusapi.com/v2", replicaId: "r1" });
    const created = await tavus.createAgent({ name: "Dr. Patel", trainVideoUrl: "https://cdn/train.mp4" });
    expect(sent).toEqual({ replica_name: "Dr. Patel", train_video_url: "https://cdn/train.mp4" });
    expect(created).toMatchObject({ id: "rnew1", kind: "personal", status: "training" });
  });
});
