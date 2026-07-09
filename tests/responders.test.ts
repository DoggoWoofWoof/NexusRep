import { describe, expect, it } from "vitest";
import { getResponder, listResponders } from "@modules/realtime";

describe("realtime arena responders", () => {
  it("lists providers; mock available, LLM providers gated on keys (offline)", () => {
    const list = listResponders();
    const byName = Object.fromEntries(list.map((r) => [r.name, r]));
    expect(byName.mock!.available).toBe(true);
    expect(byName.claude!.available).toBe(false);
    expect(byName.openai!.available).toBe(false);
  });

  it("mock responder streams the canned answer to completion", async () => {
    const mock = getResponder("mock")!;
    let out = "";
    for await (const tok of mock.stream("anything")) out += tok;
    expect(out).toContain("once daily");
    expect(out.length).toBeGreaterThan(50);
  });

  it("mock responder stops promptly when aborted", async () => {
    const mock = getResponder("mock")!;
    const ctrl = new AbortController();
    let count = 0;
    setTimeout(() => ctrl.abort(), 30);
    for await (const _tok of mock.stream("anything", ctrl.signal)) count++;
    expect(count).toBeLessThan(5); // aborted before streaming the whole canned answer
  });
});
