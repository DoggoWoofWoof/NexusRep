import { afterEach, describe, expect, it, vi } from "vitest";

const savedEnv = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...savedEnv };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("@lib/env");
}

afterEach(() => {
  vi.resetModules();
  process.env = { ...savedEnv };
});

describe("environment composition modes", () => {
  it("lets Tavus inherit grounded LLM composition when a model key is configured", async () => {
    const { env } = await loadEnv({
      ANTHROPIC_API_KEY: "test-key",
      NEXUSREP_COMPOSE: undefined,
      NEXUSREP_TAVUS_COMPOSE: undefined,
    });

    expect(env.composeMode).toBe("llm");
    expect(env.tavusComposeMode).toBe("llm");
  });

  it("allows deterministic Tavus composition only as an explicit override", async () => {
    const { env } = await loadEnv({
      ANTHROPIC_API_KEY: "test-key",
      NEXUSREP_COMPOSE: undefined,
      NEXUSREP_TAVUS_COMPOSE: "deterministic",
    });

    expect(env.composeMode).toBe("llm");
    expect(env.tavusComposeMode).toBe("deterministic");
  });
});

describe("Tavus latency tuning env", () => {
  it("pins the default Tavus TTS stack for low-latency speech", async () => {
    const { env } = await loadEnv({
      NEXUSREP_TAVUS_TTS_ENGINE: undefined,
      NEXUSREP_TAVUS_TTS_MODEL: undefined,
      NEXUSREP_TAVUS_TTS_SPEED: undefined,
    });

    expect(env.tavusTtsEngine).toBe("cartesia");
    expect(env.tavusTtsModel).toBe("sonic-3");
    expect(env.tavusTtsSpeed).toBe(1.08);
  });

  it("clamps Tavus TTS speed to the supported range", async () => {
    const { env } = await loadEnv({ NEXUSREP_TAVUS_TTS_SPEED: "2" });
    expect(env.tavusTtsSpeed).toBe(1.2);
  });
});
