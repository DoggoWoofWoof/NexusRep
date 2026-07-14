/**
 * firstSetupGapIndex (src/app/_app/data.ts) — the logic that lets a document autofill only PART of
 * the setup and the guided script resume at exactly what it left blank. A doc that fills 14 values
 * but leaves a couple in the middle must have those gaps asked back, not silently skipped.
 */

import { describe, expect, it } from "vitest";
import { firstSetupGapIndex } from "../src/app/_app/data";

// A representative slice of the real scripted topics + their topic-key → server-field mapping.
const TOPICS = [
  { key: "brand" }, { key: "indication" }, { key: "persona" }, { key: "audience" },
  { key: "knowledge" }, { key: "escalation" }, { key: "talking" }, { key: "forbidden" }, { key: "sponsor" },
];
const ANSWER_KEY: Record<string, string> = {
  brand: "brand", indication: "indication", persona: "persona_type", audience: "target_audience",
  knowledge: "approved_content", escalation: "msl_contact", talking: "talking_points",
  forbidden: "blocked_topics", sponsor: "sponsor",
};

describe("firstSetupGapIndex", () => {
  it("resumes at the first field a document did NOT fill (gap in the middle)", () => {
    // Doc filled brand, indication, escalation, talking, sponsor — persona/audience/knowledge remain.
    const filled = new Set(["brand", "indication", "msl_contact", "talking_points", "sponsor"]);
    expect(firstSetupGapIndex(TOPICS, ANSWER_KEY, filled)).toBe(2); // persona
  });

  it("skips already-filled questions when scanning from a later point", () => {
    const filled = new Set(["brand", "indication", "persona_type"]);
    // From index 1: indication + persona filled, so the next gap is audience (index 3).
    expect(firstSetupGapIndex(TOPICS, ANSWER_KEY, filled, 1)).toBe(3);
  });

  it("returns topics.length when everything the script asks is already filled", () => {
    const filled = new Set(Object.values(ANSWER_KEY));
    expect(firstSetupGapIndex(TOPICS, ANSWER_KEY, filled)).toBe(TOPICS.length);
  });

  it("returns 0 when nothing is filled (fresh start)", () => {
    expect(firstSetupGapIndex(TOPICS, ANSWER_KEY, new Set())).toBe(0);
  });

  it("treats a topic with no server-key mapping as a gap (never silently skipped)", () => {
    const topics = [{ key: "brand" }, { key: "mystery" }, { key: "sponsor" }];
    const filled = new Set(["brand", "sponsor"]);
    expect(firstSetupGapIndex(topics, ANSWER_KEY, filled)).toBe(1); // "mystery" has no mapping → gap
  });

  it("does not scan before `from` even if an earlier gap exists", () => {
    const filled = new Set(["indication"]); // brand (index 0) is a gap, but we start from index 1
    expect(firstSetupGapIndex(TOPICS, ANSWER_KEY, filled, 1)).toBe(2); // persona, not brand
  });
});
