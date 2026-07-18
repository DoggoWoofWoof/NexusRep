/**
 * PII redaction at the vendor boundary: patient identifiers are scrubbed, but clinical language,
 * drug/program names, and dosing numbers survive — so the classifier/composer still work and an
 * adverse-event / off-label signal is never masked.
 */

import { describe, expect, it } from "vitest";
import { redactPii, redactPiiDetailed } from "@lib/pii-redact";

describe("redactPii — scrubs identifiers", () => {
  it("redacts email, phone, SSN", () => {
    expect(redactPii("reach me at john.doe@example.com")).toContain("[REDACTED_EMAIL]");
    expect(redactPii("call 555-123-4567")).toContain("[REDACTED_PHONE]");
    expect(redactPii("555 123 4567 or 5551234567")).not.toMatch(/\d{3}[\s.]?\d{4}/);
    expect(redactPii("SSN 123-45-6789")).toContain("[REDACTED_SSN]");
  });

  it("redacts MRN, DOB, member id (keyword-anchored)", () => {
    expect(redactPii("patient MRN: A1234567")).toContain("[REDACTED_MRN]");
    expect(redactPii("DOB 03/14/1975")).toContain("[REDACTED_DOB]");
    expect(redactPii("date of birth: January 5, 1980")).toContain("[REDACTED_DOB]");
    expect(redactPii("member id: XZ-99012")).toContain("[REDACTED_MEMBER_ID]");
  });

  it("redacts titled personal names", () => {
    expect(redactPii("Mr. Smith reported")).toContain("[REDACTED_NAME]");
    expect(redactPii("saw Mrs. Jane Doe")).toContain("[REDACTED_NAME]");
  });
});

describe("redactPii — preserves clinical content", () => {
  it("never touches drug/program names or dosing (no title precedes them)", () => {
    const q = "Is Milvexian approved for afib? What about Factor XIa and a 500 mg dose?";
    expect(redactPii(q)).toBe(q);
  });

  it("keeps the adverse-event / off-label signal intact while masking the patient name", () => {
    const out = redactPii("Mr. Jones had a serious bleeding event on milvexian");
    expect(out).toContain("[REDACTED_NAME]");
    expect(out).toContain("bleeding event"); // AE signal survives → routing/gating unaffected
    expect(out).toContain("milvexian");
  });

  it("returns unchanged text when there is nothing to redact, and is stable on empty", () => {
    expect(redactPii("what is the dosing frequency?")).toBe("what is the dosing frequency?");
    expect(redactPii("")).toBe("");
  });
});

describe("redactPiiDetailed — observability without leaking values", () => {
  it("reports per-kind counts", () => {
    const r = redactPiiDetailed("email a@b.com, phone 555-123-4567, and Dr. House");
    expect(r.count).toBe(3);
    expect(r.kinds.email).toBe(1);
    expect(r.kinds.phone).toBe(1);
    expect(r.kinds.name).toBe(1);
    // the result carries counts, never the original identifier values
    expect(JSON.stringify(r.kinds)).not.toContain("a@b.com");
  });
});
