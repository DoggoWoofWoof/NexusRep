import { describe, it, expect } from "vitest";
import { deriveLexicon, deriveProductTerms, deriveTopicSynonyms, mergeLexicon, scoreLexiconCoverage } from "@modules/content";

// Stand-in for "the ingested Milvexian deck" — topic-tagged blocks like ingestSource produces.
const blocks = [
  { topic: "mechanism", text: "Milvexian is an oral Factor XIa (FXIa) inhibitor targeting the coagulation cascade." },
  { topic: "mechanism", text: "By inhibiting FXIa, Milvexian reduces thrombin generation in the intrinsic coagulation pathway." },
  { topic: "indication", text: "The LIBREXIA program studies acute coronary syndrome and atrial fibrillation stroke prevention." },
  { topic: "indication", text: "LIBREXIA evaluates secondary prevention across coronary and fibrillation indications." },
  { topic: "safety", text: "Important Safety data: bleeding risk and hypersensitivity warnings apply." },
];

describe("dynamic lexicon derivation (learned from ingested content, no hardcoding)", () => {
  it("derives product terms — acronyms + proper nouns — from the content", () => {
    const terms = deriveProductTerms(blocks);
    expect(terms).toContain("milvexian");
    expect(terms).toContain("fxia");
    expect(terms).toContain("librexia");
  });

  it("derives per-topic synonyms that DISTINGUISH each topic (TF-IDF)", () => {
    const syn = deriveTopicSynonyms(blocks);
    expect((syn.mechanism ?? []).join(" ")).toMatch(/coagulation|thrombin|inhibit/);
    expect((syn.indication ?? []).join(" ")).toMatch(/coronary|fibrillation|prevention/);
    // "coagulation" occurs only in mechanism blocks → it must NOT surface as an indication synonym.
    expect(syn.indication ?? []).not.toContain("coagulation");
  });
});

describe("benchmark the derivation against the hand-authored lexicon", () => {
  // The kept, hardcoded reference. "apixaban" never appears in the content above (a comparator the
  // deck doesn't name) — so the benchmark should report it as MISSED, revealing the gap to tune.
  const reference = {
    productTerms: ["milvexian", "librexia", "fxia", "apixaban"],
    topicSynonyms: { mechanism: ["coagulation", "inhibitor"], indication: ["coronary", "fibrillation"] },
  };

  it("scores recall and surfaces what's missed vs extra", () => {
    const cov = scoreLexiconCoverage(deriveLexicon(blocks), reference);
    expect(cov.productTermsFound).toEqual(expect.arrayContaining(["milvexian", "librexia", "fxia"]));
    expect(cov.productTermsMissed).toContain("apixaban");
    expect(cov.productTermRecall).toBeGreaterThan(0.5);
    expect(cov.productTermRecall).toBeLessThan(1); // the benchmark reveals the gap, not a false 100%
    expect(cov.topicSynonymRecall).toBeGreaterThan(0); // some hand-authored topic terms recovered
  });

  it("merge keeps the hand-authored set as a FLOOR (union), never regressing", () => {
    const merged = mergeLexicon(deriveLexicon(blocks), reference);
    expect(merged.productTerms).toContain("apixaban"); // reference floor preserved even though derivation missed it
    expect(merged.productTerms).toContain("milvexian"); // derived terms present too
  });
});
