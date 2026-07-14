/**
 * The agentic DocNexus Setup Assistant (src/modules/setupAssistant/agent.ts). Locks down the
 * intent→action mapping the brand user relies on AND the compliance guardrails that must hold even
 * if the model misbehaves: ingest only with an attachment, no ICD/unknown fields, no overwriting a
 * user's answer, no ISI nag when one exists, and a working deterministic fallback with no LLM.
 */

import { describe, expect, it } from "vitest";
import { setupAssistantTurn, type SetupTurnInput } from "@modules/setupAssistant";

const llmReturning = (payload: unknown) => async () => (typeof payload === "string" ? payload : JSON.stringify(payload));

const base: SetupTurnInput = { message: "", known: {}, hasIsi: false };

describe("setupAssistantTurn — agentic intent → proposed actions", () => {
  it("proposes ingesting an attached document (the 'use this doc' intent)", async () => {
    const turn = await setupAssistantTurn(
      { ...base, message: "here's our deck, use it for the rep", attachment: { name: "Milvexian MoA.pptx", text: "Milvexian is a Factor XIa inhibitor..." } },
      llmReturning({ reply: "Happy to — I can pull this in for review.", actions: [{ type: "ingest_document", summary: "Ingest “Milvexian MoA.pptx” for MLR review" }] }),
    );
    expect(turn.actions.map((a) => a.type)).toContain("ingest_document");
    expect(turn.reply).toBeTruthy();
  });

  it("DROPS an ingest proposal when no document is attached (can't ingest thin air)", async () => {
    const turn = await setupAssistantTurn(
      { ...base, message: "ingest the deck", attachment: null },
      llmReturning({ reply: "…", actions: [{ type: "ingest_document", summary: "Ingest the deck" }] }),
    );
    expect(turn.actions.some((a) => a.type === "ingest_document")).toBe(false);
  });

  it("accepts set_field for an allowed key but DROPS unknown keys and ICD/diagnosis codes", async () => {
    const turn = await setupAssistantTurn(
      { ...base, message: "focus it on atrial fibrillation" },
      llmReturning({
        reply: "Sure.",
        actions: [
          { type: "set_field", fieldKey: "indication", value: "Atrial fibrillation" },
          { type: "set_field", fieldKey: "diagnosis_codes", value: "I48.91" }, // must be dropped — resolver-only
          { type: "set_field", fieldKey: "made_up_key", value: "x" }, // unknown — dropped
        ],
      }),
    );
    const setFields = turn.actions.filter((a) => a.type === "set_field");
    expect(setFields).toHaveLength(1);
    expect(setFields[0]!.fieldKey).toBe("indication");
    expect(setFields[0]!.value).toBe("Atrial fibrillation");
  });

  it("allows an explicit field change (the confirm step is the safety) but drops a no-op re-set", async () => {
    const change = await setupAssistantTurn(
      { ...base, message: "actually rename it to CardioRep", known: { brand: "Milvexian" } },
      llmReturning({ reply: "Sure.", actions: [{ type: "set_field", fieldKey: "brand", value: "CardioRep" }] }),
    );
    expect(change.actions.find((a) => a.type === "set_field")?.value).toBe("CardioRep");

    const noop = await setupAssistantTurn(
      { ...base, message: "keep it Milvexian", known: { brand: "Milvexian" } },
      llmReturning({ reply: "Got it.", actions: [{ type: "set_field", fieldKey: "brand", value: "Milvexian" }] }),
    );
    expect(noop.actions.some((a) => a.type === "set_field")).toBe(false);
  });

  it("drafts a conversation rule from a 'never …' instruction, with a scope", async () => {
    const turn = await setupAssistantTurn(
      { ...base, message: "never let it discuss dosing" },
      llmReturning({ reply: "Got it.", actions: [{ type: "draft_rule", ruleFeedback: "Never discuss dosing", ruleScope: "persona" }] }),
    );
    const rule = turn.actions.find((a) => a.type === "draft_rule");
    expect(rule?.ruleFeedback).toMatch(/dosing/i);
    expect(rule?.ruleScope).toBe("persona");
  });

  it("flags a missing ISI, but NOT when one already exists", async () => {
    const missing = await setupAssistantTurn(
      { ...base, message: "are we ready to launch?", hasIsi: false },
      llmReturning({ reply: "Almost.", actions: [{ type: "flag_isi", summary: "ISI required before launch" }] }),
    );
    expect(missing.actions.some((a) => a.type === "flag_isi")).toBe(true);

    const present = await setupAssistantTurn(
      { ...base, message: "are we ready to launch?", hasIsi: true },
      llmReturning({ reply: "Looking good.", actions: [{ type: "flag_isi", summary: "ISI required before launch" }] }),
    );
    expect(present.actions.some((a) => a.type === "flag_isi")).toBe(false);
  });

  it("parses model output even when wrapped in prose or ```json fences", async () => {
    const turn = await setupAssistantTurn(
      { ...base, message: "focus on cardiology" },
      llmReturning('Sure, here you go:\n```json\n{"reply":"On it.","actions":[{"type":"set_field","fieldKey":"therapeutic_area","value":"Cardiology"}]}\n```\nLet me know!'),
    );
    expect(turn.reply).toBe("On it.");
    expect(turn.actions[0]).toMatchObject({ type: "set_field", fieldKey: "therapeutic_area", value: "Cardiology" });
  });

  it("falls back to a useful, humanlike turn when the model output is garbage", async () => {
    const turn = await setupAssistantTurn(
      { ...base, message: "here is our PI", attachment: { name: "PI.pdf", text: "prescribing info" } },
      llmReturning("not json at all, sorry"),
    );
    expect(turn.reply).toBeTruthy();
    expect(turn.actions.some((a) => a.type === "ingest_document")).toBe(true);
  });
});

describe("setupAssistantTurn — deterministic fallback (no LLM)", () => {
  it("still proposes ingest for an attachment and a rule for a 'don't' instruction", async () => {
    const withDoc = await setupAssistantTurn({ ...base, message: "use this", attachment: { name: "deck.pptx", text: "..." } });
    expect(withDoc.actions.some((a) => a.type === "ingest_document")).toBe(true);
    expect(withDoc.reply).toBeTruthy();

    const rule = await setupAssistantTurn({ ...base, message: "don't mention competitors" });
    expect(rule.actions.some((a) => a.type === "draft_rule")).toBe(true);
  });

  it("flags a missing ISI in fallback mode too", async () => {
    const turn = await setupAssistantTurn({ ...base, message: "hi", hasIsi: false });
    expect(turn.actions.some((a) => a.type === "flag_isi")).toBe(true);
  });

  it("extracts a brand rename from an explicit instruction with no LLM (keeps rebrand-by-chat working)", async () => {
    const turn = await setupAssistantTurn({ ...base, message: "rename the product to CardioNova", known: { brand: "Milvexian" } });
    expect(turn.actions.find((a) => a.type === "set_field")).toMatchObject({ fieldKey: "brand", value: "CardioNova" });
  });

  it("reports progress on request — what's filled, what's still open, ISI status — with no LLM", async () => {
    const turn = await setupAssistantTurn({
      ...base,
      message: "what have you filled so far?",
      known: { brand: "Milvexian", indication: "Atrial fibrillation" },
      hasIsi: true,
    });
    expect(turn.reply).toMatch(/Milvexian/);
    expect(turn.reply).toMatch(/atrial fibrillation/i);
    expect(turn.reply).toMatch(/still open|target specialties/i);
    expect(turn.actions).toHaveLength(0); // a pure status report proposes nothing
  });
});
