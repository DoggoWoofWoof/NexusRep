/**
 * Concurrent live-video isolation. The Tavus custom-LLM path is cookie-less, so it resolves the
 * owning account from the per-user LLM URL (/api/tavus/llm/o/<owner>) + a per-owner active-call —
 * NOT a single global. These lock in that two accounts on video at once never cross-write.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@lib/env";
import { setActiveCall, getActiveCall } from "@lib/active-call";
import { getContainerForUser } from "@lib/container";
import { POST as ownerCompletions } from "@/app/api/tavus/llm/o/[owner]/chat/completions/route";

describe("active-call is keyed by owner (no cross-user supersede)", () => {
  it("a second account's call does not clobber the first's", () => {
    setActiveCall({ sessionId: "session_iso_a", userId: "iso_a" });
    setActiveCall({ sessionId: "session_iso_b", userId: "iso_b" });
    expect(getActiveCall("iso_a")?.sessionId).toBe("session_iso_a");
    expect(getActiveCall("iso_b")?.sessionId).toBe("session_iso_b");
  });
});

describe("owner-scoped Tavus LLM route logs to the RIGHT account's container", () => {
  beforeAll(() => { (env as { tavusLlmKey: string }).tavusLlmKey = "test-llm-key"; });
  afterAll(() => { (env as { tavusLlmKey: string }).tavusLlmKey = ""; });

  const call = (owner: string, text: string) =>
    ownerCompletions(
      new Request(`http://localhost/api/tavus/llm/o/${owner}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer test-llm-key" },
        body: JSON.stringify({ messages: [{ role: "user", content: text }], stream: false }),
      }),
      { params: Promise.resolve({ owner }) },
    );

  it("a turn on /o/<A> lands in A's session and never touches B's", async () => {
    const ca = await getContainerForUser("iso_owner_a");
    const cb = await getContainerForUser("iso_owner_b");
    const sa = await ca.conversation.start({ aiRepId: ca.demo.aiRepId, hcpId: ca.demo.hcpId, preview: true, seed: "iso_a_sess" });
    const sb = await cb.conversation.start({ aiRepId: cb.demo.aiRepId, hcpId: cb.demo.hcpId, preview: true, seed: "iso_b_sess" });
    // Both accounts "on video at once".
    setActiveCall({ sessionId: String(sa.id), userId: "iso_owner_a" });
    setActiveCall({ sessionId: String(sb.id), userId: "iso_owner_b" });

    const res = await call("iso_owner_a", "What is Milvexian and how does it work?");
    expect(res.status).toBe(200);
    await res.json();

    // A's session recorded the turn; B's session is untouched (no cross-write).
    const savedA = await ca.sessions.get(sa.id);
    const savedB = await cb.sessions.get(sb.id);
    expect(savedA?.turns.some((t) => t.speaker === "hcp")).toBe(true);
    expect(savedB?.turns.some((t) => t.speaker === "hcp")).toBe(false);
    // And B's active call is still intact after A's turn.
    expect(getActiveCall("iso_owner_b")?.sessionId).toBe(String(sb.id));
  }, 30_000);
});
