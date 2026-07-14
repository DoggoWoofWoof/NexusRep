/**
 * Regression: the LLM classifier silently died on Render because the model returned valid JSON
 * followed by a trailing sentence ("Unexpected non-whitespace character after JSON"), and a raw
 * JSON.parse threw — dropping every turn to the dumb keyword classifier. parseClassification must
 * extract the first balanced object and ignore trailing prose / code fences / preamble.
 */

import { describe, expect, it } from "vitest";
import { parseClassification } from "@modules/compliance/classifiers/shared";

const OBJ = `{"intent":"product_info","confidence":0.9,"offLabelRisk":0,"adverseEventRisk":0,"medicalInfoRisk":0,"promptInjectionRisk":0,"comparativeClaimRisk":0,"isiRequired":true}`;

describe("parseClassification tolerates real model output", () => {
  it("clean JSON", () => {
    expect(parseClassification(OBJ).intent).toBe("product_info");
  });

  it("JSON followed by a trailing sentence (the Render failure)", () => {
    const out = parseClassification(`${OBJ}\n\nThis message is a general product question.`);
    expect(out.intent).toBe("product_info");
    expect(out.isiRequired).toBe(true);
  });

  it("JSON wrapped in ```json fences", () => {
    expect(parseClassification("```json\n" + OBJ + "\n```").intent).toBe("product_info");
  });

  it("JSON after a preamble line", () => {
    expect(parseClassification("Here is the classification:\n" + OBJ).confidence).toBeCloseTo(0.9);
  });

  it("nested braces inside a string value don't truncate the object", () => {
    const nested = `{"intent":"other","confidence":0.5,"offLabelRisk":0,"adverseEventRisk":0,"medicalInfoRisk":0,"promptInjectionRisk":0,"comparativeClaimRisk":0,"isiRequired":false} trailing`;
    expect(parseClassification(nested).intent).toBe("other");
  });

  it("parses the Claude prefill continuation ('{' + the model's remainder)", () => {
    // claude.ts prefills the reply with "{" and prepends it back before parsing, so the model's
    // output is the object MINUS its opening brace. This is the shape parseClassification now sees.
    const continuation = `"intent":"other","confidence":0.3,"offLabelRisk":0,"adverseEventRisk":0,"medicalInfoRisk":0,"promptInjectionRisk":0,"comparativeClaimRisk":0,"isiRequired":false}`;
    const out = parseClassification("{" + continuation);
    expect(out.intent).toBe("other");
    expect(out.confidence).toBeCloseTo(0.3);
  });
});
