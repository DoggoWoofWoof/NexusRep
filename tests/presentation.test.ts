import { describe, expect, it } from "vitest";
import { createContainer } from "@lib/container";

describe("NexusRep first-party presentation skill", () => {
  it("starts the slide-led overview from the first active slide", async () => {
    const c = await createContainer();
    const step = await c.presentation.step({
      action: "start",
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
    });

    expect(step?.detailAidSlideId).toBe("slide_title");
    expect(step?.sourceIds).toEqual(["ans_title"]);
    expect(step?.text).toContain("slide-led overview");
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
    expect(step?.text).toContain("Let's move");
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
      "slide_af",
      "slide_acs",
      "slide_stroke",
      "slide_status",
      "slide_isi",
      "slide_contact",
    ]);
    expect(steps.map((s) => s.sourceIds[0])).toEqual([
      "ans_title",
      "ans_moa",
      "ans_program",
      "ans_librexia_af",
      "ans_librexia_acs",
      "ans_librexia_stroke",
      "ans_status",
      "ans_isi",
      "ans_contact",
    ]);
    expect(steps[0]?.text).toMatch(/high-level|stage|story/i);
    expect(steps.map((s) => s.text).join("\n")).not.toContain("the The");
    expect(steps[2]?.text).toContain("LIBREXIA");
    expect(steps[6]?.text).toContain("not FDA approved");
    expect(steps[7]?.text).toContain("Important Safety Information");
    expect(steps[8]?.text).toContain("human representative");
  });

  it("uses presentation coaching to lead with a requested approved slide", async () => {
    const c = await createContainer();
    const steps = await c.presentation.overview({
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
      guidance: ["Start the guided overview with the LIBREXIA program slide, then use mechanism."],
    });

    expect(steps[0]?.detailAidSlideId).toBe("slide_program");
    expect(steps[0]?.sourceIds).toEqual(["ans_program"]);
    expect(steps.map((s) => s.detailAidSlideId)).toContain("slide_moa");
  });

  it("uses a saved guided-overview plan to drive section-by-section slide references", async () => {
    const c = await createContainer();
    const steps = await c.presentation.overview({
      context: { audience: c.demo.audience, indication: c.demo.indication, market: c.demo.market },
      plan: {
        steps: [
          { id: "overview_step_1", title: "Program section", slideId: "slide_program", instruction: "Start briefly with this section." },
          { id: "overview_step_2", title: "Mechanism section", slideId: "slide_moa", instruction: "For this section refer to the mechanism slide." },
        ],
      },
    });

    expect(steps[0]?.detailAidSlideId).toBe("slide_program");
    expect(steps[0]?.sourceIds).toEqual(["ans_program"]);
    expect(steps[0]?.text).toContain("start briefly");
    expect(steps[1]?.detailAidSlideId).toBe("slide_moa");
    expect(steps[1]?.sourceIds).toEqual(["ans_moa"]);
  });
});
