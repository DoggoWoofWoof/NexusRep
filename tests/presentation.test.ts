import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";

describe("NexusRep first-party presentation skill", () => {
  it("starts the approved deck walkthrough from the first active slide", async () => {
    const c = await createContainer();
    const step = await c.presentation.step({
      action: "start",
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
    });

    expect(step?.detailAidSlideId).toBe("slide_title");
    expect(step?.sourceIds).toEqual(["ans_title"]);
    expect(step?.text).toContain("Let's walk through the approved deck");
    expect(step?.text).toContain("Milvexian is presented");
  });

  it("advances to the next approved slide using source deck order", async () => {
    const c = await createContainer();
    const step = await c.presentation.step({
      action: "next",
      currentSlideId: "slide_title",
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
    });

    expect(step?.detailAidSlideId).toBe("slide_moa");
    expect(step?.sourceIds).toEqual(["ans_moa"]);
    expect(step?.text).toContain("Next, let's move");
  });

  it("jumps to the best approved slide for a topic query", async () => {
    const c = await createContainer();
    const step = await c.presentation.step({
      action: "jump",
      query: "FDA status",
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
    });

    expect(step?.detailAidSlideId).toBe("slide_status");
    expect(step?.sourceIds).toEqual(["ans_status"]);
    expect(step?.text).toContain("not FDA approved");
  });

  it("builds a rep-led overview across multiple approved slides", async () => {
    const c = await createContainer();
    const steps = await c.presentation.overview({
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
    });

    expect(steps.map((s) => s.detailAidSlideId)).toEqual([
      "slide_title",
      "slide_moa",
      "slide_program",
      "slide_status",
      "slide_isi",
      "slide_contact",
    ]);
    expect(steps.map((s) => s.sourceIds[0])).toEqual([
      "ans_title",
      "ans_moa",
      "ans_program",
      "ans_status",
      "ans_isi",
      "ans_contact",
    ]);
    expect(steps[0]?.text).toMatch(/high-level|stage|story/i);
    expect(steps.map((s) => s.text).join("\n")).not.toContain("the The");
    expect(steps[2]?.text).toContain("LIBREXIA");
    expect(steps[3]?.text).toContain("not FDA approved");
    expect(steps[4]?.text).toContain("Important Safety Information");
    expect(steps[5]?.text).toContain("human representative");
  });
});
