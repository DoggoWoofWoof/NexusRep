import { afterEach, describe, expect, it, vi } from "vitest";
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
      replicaId: "r1",
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

    await tavus.endSession();
    expect(calls.some((c) => c.url.endsWith("/end"))).toBe(true);
  });
});

describe("Tavus custom-LLM endpoint preserves the compliance gate", () => {
  const call = (userText: string) =>
    llmCompletions(new Request("http://localhost/api/tavus/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: userText }], stream: true }),
    }));

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
