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
