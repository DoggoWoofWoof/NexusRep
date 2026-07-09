import { describe, expect, it } from "vitest";
import { InMemoryVectorIndex } from "@lib/vector-index";
import { lexicalEmbed, cosine } from "@lib/embeddings";

// Tests run with the deterministic lexical (stemmed) provider.
describe("retrieval ranking (stemmed lexical fallback)", () => {
  it("ranks the dosing block first for a dosing query (dosing↔dose↔doses)", async () => {
    const index = new InMemoryVectorIndex();
    await index.upsert({ refId: "ans_dosing", metadata: { market: "IN" }, text: "dosing Dolo 650 contains paracetamol 650 mg the approved dose is one tablet every 4 to 6 hours" });
    await index.upsert({ refId: "ans_safety", metadata: { market: "IN" }, text: "safety Dolo 650 is generally well tolerated the principal risk is liver injury with overdose" });
    await index.upsert({ refId: "ans_trial", metadata: { market: "IN" }, text: "trial_data approved onset-of-action study 650 mg strength meaningful analgesia consistent with every six hour dosing" });

    const out = await index.query({ text: "What is the dosing for Dolo 650?", topK: 3 });
    expect(out[0]?.refId).toBe("ans_dosing");
  });

  it("stemming maps dose/dosing/doses to the same token", () => {
    const a = lexicalEmbed("dose");
    const b = lexicalEmbed("dosing");
    const c = lexicalEmbed("doses");
    expect(cosine(a, b)).toBeCloseTo(1, 5);
    expect(cosine(a, c)).toBeCloseTo(1, 5);
  });

  it("respects metadata filters", async () => {
    const index = new InMemoryVectorIndex();
    await index.upsert({ refId: "in", metadata: { market: "IN" }, text: "dosing dolo" });
    await index.upsert({ refId: "us", metadata: { market: "US" }, text: "dosing dolo" });
    const out = await index.query({ text: "dosing dolo", filter: { market: "IN" } });
    expect(out.map((c) => c.refId)).toEqual(["in"]);
  });
});
