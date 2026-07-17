/**
 * Live ASR fragment buffering (extracted from the Tavus custom-LLM route into @modules/realtime).
 * Locks in the turn-shaping + the SAFETY carve-out: an adverse-event report is never buffered.
 */

import { describe, expect, it } from "vitest";
import {
  isLikelyIncompleteFragment,
  mergeOrBufferFragment,
  shouldIgnoreTrailingRecoveredFragment,
  markRecoveredFragmentWindow,
  rememberRecoveredFragmentReply,
  getRecoveredFragmentReply,
  FRAGMENT_WINDOW_MS,
} from "@modules/realtime";

describe("fragment buffer — live ASR turn shaping", () => {
  it("flags an incomplete fragment but NEVER an adverse-event report", () => {
    expect(isLikelyIncompleteFragment("What is the,")).toBe(true); // trailing comma
    expect(isLikelyIncompleteFragment("what is")).toBe(true); // short interrogative lead-in
    expect(isLikelyIncompleteFragment("Milvexian is investigational.")).toBe(false); // complete
    // Safety carve-out: an AE report must be processed immediately, not held behind buffering.
    expect(isLikelyIncompleteFragment("my patient developed bleeding after taking it,")).toBe(false);
    expect(isLikelyIncompleteFragment("the liberation,")).toBe(false); // recovered mis-hearing
  });

  it("buffers then MERGES a continuation within the window", () => {
    const k = "sess_merge";
    const t0 = 1_000_000;
    expect(mergeOrBufferFragment(k, "What is the,", t0)).toEqual({ action: "buffer" });
    const merged = mergeOrBufferFragment(k, "LIBREXIA program?", t0 + 500);
    expect(merged.action).toBe("process");
    if (merged.action === "process") {
      expect(merged.merged).toBe(true);
      // The merge joins on whitespace; the prev fragment's trailing comma is preserved verbatim.
      expect(merged.text).toBe("What is the, LIBREXIA program?");
    }
  });

  it("processes a complete sentence without buffering", () => {
    expect(mergeOrBufferFragment("sess_complete", "How does Milvexian work?", 2_000_000)).toEqual({
      action: "process",
      text: "How does Milvexian work?",
    });
  });

  it("ignores a tiny trailing shard ONLY inside the recovered window", () => {
    const k = "sess_shard";
    const t0 = 3_000_000;
    expect(shouldIgnoreTrailingRecoveredFragment(k, "brue?", t0)).toBe(false); // no window opened yet
    markRecoveredFragmentWindow(k, t0);
    expect(shouldIgnoreTrailingRecoveredFragment(k, "brue?", t0 + 500)).toBe(true); // inside window + tiny shard
    expect(shouldIgnoreTrailingRecoveredFragment(k, "brue?", t0 + FRAGMENT_WINDOW_MS + 1)).toBe(false); // expired
  });

  it("caches then expires a recovered reply", () => {
    const k = "sess_reply";
    const t0 = 4_000_000;
    rememberRecoveredFragmentReply(k, "The approved answer.", 2500, t0);
    expect(getRecoveredFragmentReply(k, t0 + 1000)).toBe("The approved answer.");
    expect(getRecoveredFragmentReply(k, t0 + 999_999)).toBeNull(); // past TTL
  });
});
