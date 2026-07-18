import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@modules": r("./src/modules"),
      "@lib": r("./src/lib"),
      "@": r("./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // Tests drive the brand API routes directly (no cookie / no Next request pipeline), so run with
    // auth OFF — the same as the Playwright E2E config. requireBrandUser's own branches are unit-tested
    // in tests/require-auth.test.ts by mocking its deps, independent of this flag.
    env: { NEXUSREP_AUTH: "0", NEXUSREP_RATELIMIT: "0" },
  },
});
