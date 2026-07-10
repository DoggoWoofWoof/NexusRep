import { describe, expect, it } from "vitest";
import { classify, compareClassifiers, getClassifier, resolveClassifier } from "@modules/compliance";
import { mergeWithKeywordSignals } from "@modules/compliance/classifiers";
import { parseClassification } from "@modules/compliance/classifiers/shared";

describe("classifier registry", () => {
  it("always has the keyword classifier available", () => {
    const kw = getClassifier("keyword");
    expect(kw?.available()).toBe(true);
  });

  it("reports LLM providers as unavailable without keys", () => {
    // Tests run with no API keys → these must not be 'available' and must not throw.
    expect(getClassifier("claude")?.available()).toBe(false);
    expect(getClassifier("openai")?.available()).toBe(false);
    expect(getClassifier("thinking-machines")?.available()).toBe(false);
  });

  it("compareClassifiers returns every provider; only keyword has a result offline", async () => {
    const rows = await compareClassifiers("Can I use this off-label for kids?");
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.keyword!.available).toBe(true);
    expect(byName.keyword!.result?.intent).toBe("off_label");
    expect(byName.claude!.available).toBe(false);
    expect(byName.openai!.available).toBe(false);
  });

  it("resolveClassifier defaults to keyword behavior (async)", async () => {
    const classifyFn = resolveClassifier();
    const r = await classifyFn("My patient had a severe rash and swelling");
    expect(r.intent).toBe("adverse_event");
  });

  it("recovers obvious product-info follow-ups when an LLM returns a low-confidence fallback", () => {
    const merged = mergeWithKeywordSignals(
      {
        intent: "other",
        confidence: 0.4,
        offLabelRisk: 0,
        adverseEventRisk: 0,
        medicalInfoRisk: 0.8,
        promptInjectionRisk: 0,
        comparativeClaimRisk: 0,
        isiRequired: false,
      },
      classify("How does Factor XIa fit into that?"),
    );

    expect(merged.intent).toBe("product_info");
    expect(merged.medicalInfoRisk).toBeLessThan(0.6);
    expect(merged.isiRequired).toBe(true);
  });

  it("recovers human handoff requests when an LLM misses the intent", () => {
    const merged = mergeWithKeywordSignals(
      {
        intent: "other",
        confidence: 0.5,
        offLabelRisk: 0,
        adverseEventRisk: 0,
        medicalInfoRisk: 0,
        promptInjectionRisk: 0,
        comparativeClaimRisk: 0,
        isiRequired: false,
      },
      classify("Can a human representative call me after this session?"),
    );

    expect(merged.intent).toBe("human_request");
    expect(merged.isiRequired).toBe(false);
  });
});

describe("parseClassification (LLM JSON normalizer)", () => {
  it("parses and clamps a well-formed object", () => {
    const r = parseClassification('{"intent":"dosing","confidence":1.4,"offLabelRisk":-0.2,"isiRequired":true}');
    expect(r.intent).toBe("dosing");
    expect(r.confidence).toBe(1); // clamped
    expect(r.offLabelRisk).toBe(0); // clamped
    expect(r.isiRequired).toBe(true);
  });

  it("strips code fences and defaults unknown intent to 'other'", () => {
    const r = parseClassification('```json\n{"intent":"nonsense"}\n```');
    expect(r.intent).toBe("other");
  });

  it("throws on unparseable input (so callers can fail safe)", () => {
    expect(() => parseClassification("not json")).toThrow();
  });
});

// ── Keyword classifier hardening: word boundaries + AE report-vs-question ──
import { classify as kwClassify } from "@modules/compliance/classifier";
import { route as routeOf } from "@modules/compliance";

describe("keyword classifier no longer false-fires", () => {
  it("a safety QUESTION is answered, not filed as an adverse event", () => {
    const c = kwClassify("what are the side effects of this?");
    expect(c.intent).not.toBe("adverse_event");
    expect(routeOf(c)).not.toBe("adverse_event");
    expect(c.intent).toBe("safety"); // → approved safety/ISI answer
  });

  it("a genuine AE REPORT still routes to pharmacovigilance", () => {
    const c = kwClassify("My patient had bleeding after taking it");
    expect(c.intent).toBe("adverse_event");
    expect(routeOf(c)).toBe("adverse_event");
  });

  it("a bare symptom mention stays conservative (AE)", () => {
    expect(kwClassify("could this cause swelling").intent).toBe("adverse_event");
  });

  it("'superior to' is comparative, but cardiology anatomy is not", () => {
    expect(routeOf(kwClassify("is it superior to apixaban"))).toBe("medical_information");
    const anatomy = kwClassify("does it help with superior vena cava thrombosis");
    expect(anatomy.comparativeClaimRisk).toBeLessThan(0.6);
    expect(routeOf(anatomy)).not.toBe("medical_information");
  });

  it("substring false-positives are gone ('consider' no longer trips 'side')", () => {
    const c = kwClassify("should I consider this for my patient");
    expect(c.intent).not.toBe("safety");
  });
});
