import { describe, it, expect } from "vitest";
import { deriveLexicon, scoreLexiconCoverage } from "@modules/content";
import { MILVEXIAN_PROFILE } from "@modules/brand";

/**
 * Benchmark the DYNAMIC derivation against the REAL seeded Milvexian deck + its REAL hand-authored
 * lexicon. Answers "can our derived lexicon recover everything the hand-authored (seeded) one has?"
 * Prints the coverage so the gap (if any) is visible — the readout that tells us how far "learn it at
 * ingest" is from "no authoring needed".
 */
describe("derived lexicon vs the REAL seeded Milvexian deck", () => {
  it("recovers the hand-authored lexicon from the seeded approved answers", () => {
    const blocks = MILVEXIAN_PROFILE.approvedAnswers.map((a) => ({ topic: a.topic, text: a.text }));
    const derived = deriveLexicon(blocks);
    const cov = scoreLexiconCoverage(derived, MILVEXIAN_PROFILE.lexicon);

    // eslint-disable-next-line no-console
    console.log(
      "\n=== derived (from " + blocks.length + " seeded blocks) vs hand-authored lexicon ===" +
        `\nproductTerm recall : ${(cov.productTermRecall * 100).toFixed(0)}%` +
        `\n  reference        : ${JSON.stringify(MILVEXIAN_PROFILE.lexicon.productTerms)}` +
        `\n  found            : ${JSON.stringify(cov.productTermsFound)}` +
        `\n  MISSED           : ${JSON.stringify(cov.productTermsMissed)}` +
        `\n  extra candidates : ${JSON.stringify(cov.productTermsExtra.slice(0, 12))}` +
        `\ntopicSynonym recall: ${(cov.topicSynonymRecall * 100).toFixed(0)}% same-key, ${(cov.topicSynonymRecallGlobal * 100).toFixed(0)}% global (union)` +
        `\n  topic terms still needing authoring: ${JSON.stringify(cov.topicTermsMissedGlobal)}\n`,
    );

    // Assert a real floor so the benchmark is a guardrail, not just a printout.
    expect(cov.productTermRecall).toBe(1); // every hand-authored product term is now derivable
    expect(cov.topicSynonymRecallGlobal).toBeGreaterThan(0.9); // union covers all topic terms except ones absent from the deck
  });
});
