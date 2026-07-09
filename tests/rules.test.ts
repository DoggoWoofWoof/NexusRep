import { describe, expect, it } from "vitest";
import { activeSteering, generateRule } from "@modules/rules";

describe("rule generation from coaching feedback", () => {
  it("turns 'say this more briefly' into a draft persona style rule", () => {
    const rule = generateRule({ feedback: "Say this more briefly.", seed: "1" });
    expect(rule.type).toBe("persona_style");
    expect(rule.scope).toBe("persona");
    expect(rule.status).toBe("draft");
  });

  it("turns 'do not talk about Drug X' into a blocked-topic rule needing source", () => {
    const rule = generateRule({ feedback: "Do not talk about Drug X.", seed: "2" });
    expect(rule.type).toBe("blocked_topic");
    expect(rule.status).toBe("needs_source");
  });

  it("blocks an unsupported comparative claim", () => {
    const rule = generateRule({ feedback: "Say our drug is safer than competitor X.", seed: "3" });
    expect(rule.type).toBe("comparative_claim");
    expect(rule.status).toBe("blocked_by_compliance");
  });

  it("lets a comparative claim with an approved source go to MLR", () => {
    const rule = generateRule({ feedback: "We are safer than competitor X.", hasApprovedSource: true, seed: "4" });
    expect(rule.status).toBe("needs_mlr");
  });

  it("scopes an HCP-specific pointer to that HCP", () => {
    const rule = generateRule({
      feedback: "Mention adherence support earlier when adherence concerns arise.",
      appliesToHcpId: "hcp_sharma",
      topic: "adherence",
      seed: "5",
    });
    expect(rule.scope).toBe("hcp_specific");
    expect(rule.appliesToHcpId).toBe("hcp_sharma");
  });
});

describe("coaching classifier — no unsafe false positives / no false negatives", () => {
  // Benign style feedback must classify as a plain persona rule the coach can accept
  // immediately (draft) — NOT force-matched into a compliance-sensitive type.
  const benign = [
    "Use a warmer, friendlier tone.",
    "Speak a little more slowly and clearly.",
    "Sound more confident and welcoming.",
  ];
  for (const fb of benign) {
    it(`treats benign style note as a draft persona rule: "${fb}"`, () => {
      const r = generateRule({ feedback: fb, seed: fb });
      expect(r.type).toBe("persona_style");
      expect(r.status).toBe("draft");
      // Reflects the actual feedback, not a hardcoded template.
      expect(r.instruction).toBe(fb);
    });
  }

  // FAIL-SAFE: any feedback that could touch comparative/blocked/ordering content can
  // NEVER reach "active" without approval — over-matching here is safe (over-gated),
  // under-matching would be dangerous. These assert the gate, not the exact type.
  const sensitive = [
    "Say we're safer than apixaban.",       // comparative
    "Position it as superior to warfarin.",  // comparative
    "Never mention pricing.",                // blocked_topic
    "Don't mention the competitor at all.",  // blocked_topic
    "Lead with the program first.",          // ordering
  ];
  for (const fb of sensitive) {
    it(`never lets a compliance-sensitive coaching note go active without approval: "${fb}"`, () => {
      const r = generateRule({ feedback: fb, seed: fb });
      expect(r.status).not.toBe("active");
      expect(r.status).not.toBe("draft"); // draft would let a coach accept it directly
      expect(["needs_source", "needs_mlr", "blocked_by_compliance"]).toContain(r.status);
    });
  }

  it("no false negative: a real comparative claim is caught (not mislabeled persona_style)", () => {
    const r = generateRule({ feedback: "Tell doctors it works better than the standard of care.", seed: "c" });
    expect(r.type).toBe("comparative_claim");
    expect(r.status).toBe("blocked_by_compliance"); // no approved source given
  });
});

describe("activeSteering — only ACTIVE coaching steers; style guidance reaches the composer", () => {
  const active = <T extends { status: string }>(r: T) => ({ ...r, status: "active" as const });

  it("collects active persona_style instructions as styleGuidance (no topic required)", () => {
    const s = activeSteering([active(generateRule({ feedback: "Use a warmer, friendlier tone.", seed: "s1" }))]);
    expect(s.styleGuidance).toContain("Use a warmer, friendlier tone.");
    expect(s.blockedTopics).toEqual([]);
  });

  it("draft coaching never steers — the gate stays authoritative", () => {
    // A brevity note is only a DRAFT until accepted; it must not steer while pending.
    const s = activeSteering([generateRule({ feedback: "Keep it brief.", seed: "s2" })]);
    expect(s.styleGuidance).toEqual([]);
    expect(s.blockedTopics).toEqual([]);
    expect(s.leadTopics).toEqual([]);
  });

  it("blocked / lead topics require an active rule WITH a topic", () => {
    const s = activeSteering([
      active(generateRule({ feedback: "Never mention pricing.", seed: "s3" })),
      active(generateRule({ feedback: "Lead with the program.", seed: "s4" })),
    ]);
    expect(s.blockedTopics.join(" ")).toContain("pricing");
    expect(s.leadTopics.join(" ")).toContain("program");
  });
});
