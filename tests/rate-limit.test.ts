/**
 * Token-bucket rate limiter: burst up to capacity then deny, continuous refill, per-key isolation,
 * IP extraction, and the env-gated limited() wrapper (no-op when NEXUSREP_RATELIMIT=0, 429 when over).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit, clientIp, __resetRateLimitForTests } from "@lib/rate-limit";

beforeEach(() => __resetRateLimitForTests());

describe("rateLimit (pure token bucket)", () => {
  it("allows a burst up to capacity, then denies with a retry-after", () => {
    const cfg = { capacity: 3, refillPerSec: 1 };
    expect(rateLimit("k", cfg, 1000).ok).toBe(true);
    expect(rateLimit("k", cfg, 1000).ok).toBe(true);
    expect(rateLimit("k", cfg, 1000).ok).toBe(true);
    const denied = rateLimit("k", cfg, 1000);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("refills continuously over time", () => {
    const cfg = { capacity: 1, refillPerSec: 1 };
    expect(rateLimit("k", cfg, 0).ok).toBe(true);
    expect(rateLimit("k", cfg, 0).ok).toBe(false); // bucket empty
    expect(rateLimit("k", cfg, 1000).ok).toBe(true); // +1s → one token refilled
  });

  it("isolates keys (one caller can't drain another's bucket)", () => {
    const cfg = { capacity: 1, refillPerSec: 0 };
    expect(rateLimit("a", cfg, 0).ok).toBe(true);
    expect(rateLimit("a", cfg, 0).ok).toBe(false);
    expect(rateLimit("b", cfg, 0).ok).toBe(true); // separate bucket
  });
});

describe("clientIp", () => {
  it("takes the leftmost x-forwarded-for entry", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });
  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

describe("limited() — env-gated route wrapper", () => {
  async function freshLimiter(enabled: boolean) {
    vi.resetModules();
    process.env.NEXUSREP_RATELIMIT = enabled ? "1" : "0"; // limiting is OPT-IN (off unless "1")
    return import("@lib/rate-limit");
  }
  afterEach(() => {
    process.env.NEXUSREP_RATELIMIT = "0"; // restore the suite default (vitest.config)
    vi.resetModules();
  });

  it("no-ops (returns null) when disabled", async () => {
    const { limited } = await freshLimiter(false);
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.1.1.1" } });
    for (let i = 0; i < 100; i++) expect(limited(req, "auth")).toBeNull();
  });

  it("returns a 429 (with Retry-After) once the per-IP limit is exceeded", async () => {
    const { limited } = await freshLimiter(true);
    const req = new Request("http://x", { headers: { "x-forwarded-for": "2.2.2.2" } });
    // auth limit capacity is 10 → first 10 pass, 11th is throttled.
    let last: Response | null = null;
    for (let i = 0; i < 10; i++) last = limited(req, "auth");
    expect(last).toBeNull();
    const denied = limited(req, "auth");
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(429);
    expect(denied!.headers.get("retry-after")).toBeTruthy();
  });

  it("keys by IP — a different IP has its own budget", async () => {
    const { limited } = await freshLimiter(true);
    const a = new Request("http://x", { headers: { "x-forwarded-for": "3.3.3.3" } });
    const b = new Request("http://x", { headers: { "x-forwarded-for": "4.4.4.4" } });
    for (let i = 0; i < 10; i++) limited(a, "auth");
    expect(limited(a, "auth")).not.toBeNull(); // A throttled
    expect(limited(b, "auth")).toBeNull(); // B fresh
  });
});
