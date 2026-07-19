/**
 * Tavus lifecycle events → admin-readable activity lines. The point of the whole enrichment: the
 * Activity feed should say WHY a call ended (deliberate End vs timeout vs max-duration vs error)
 * instead of "Tavus system.shutdown".
 */

import { describe, expect, it } from "vitest";
import { describeTavusEvent, shutdownReasonText } from "@lib/tavus-events";

describe("describeTavusEvent — shutdowns", () => {
  it("maps a disconnect/timeout to plain English (notice)", () => {
    const d = describeTavusEvent("system.shutdown", { shutdown_reason: "participant_left_timeout" });
    expect(d.action).toBe("Video call ended — the doctor left / disconnected");
    expect(d.reason).toBe("participant_left_timeout");
    expect(d.severity).toBe("notice");
  });

  it("recognizes a deliberate end and a max-duration end", () => {
    expect(describeTavusEvent("system.shutdown", { shutdown_reason: "end_call" }).action).toContain("ended by request");
    expect(describeTavusEvent("system.shutdown", { reason: "max_call_duration" }).action).toContain("maximum call length");
  });

  it("flags an error reason as warn", () => {
    expect(describeTavusEvent("system.shutdown", { shutdown_reason: "replica_error" }).severity).toBe("warn");
  });

  it("handles a bare shutdown (no reason) and an unknown reason (de-underscored fallback)", () => {
    const bare = describeTavusEvent("system.shutdown", {});
    expect(bare.action).toBe("Video call ended");
    expect(bare.reason).toBeNull();
    expect(describeTavusEvent("system.shutdown", { shutdown_reason: "some_new_reason" }).action).toBe("Video call ended — some new reason");
  });
});

describe("describeTavusEvent — lifecycle", () => {
  it("maps join / transcript / recording / unknown events", () => {
    expect(describeTavusEvent("system.replica_joined").action).toContain("connected");
    expect(describeTavusEvent("application.transcription_ready").action).toContain("transcript");
    expect(describeTavusEvent("recording_ready").action).toContain("recording");
    expect(describeTavusEvent("something.weird").action).toBe("Video: something.weird");
  });
});

describe("shutdownReasonText", () => {
  it("maps known reasons and de-underscores unknowns", () => {
    expect(shutdownReasonText("participant_left_timeout")).toBe("the doctor left / disconnected");
    expect(shutdownReasonText("brand_new_thing")).toBe("brand new thing");
  });
});
