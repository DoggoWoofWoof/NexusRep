/**
 * ESLint flat config (`next lint` is deprecated — this is the ESLint-CLI setup).
 * Baseline: Next.js core-web-vitals + TypeScript. Strict tsc remains the primary
 * gate; lint catches the React/Next foot-guns tsc can't (hooks rules, a11y, img).
 */
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "test-results/**",
      "playwright-report/**",
      ".nexusrep-data/**",
      "advanced-search/**", // separate app with its own tooling
      "public/**",
      "support.js", // GENERATED legacy dc-runtime bundle (do not edit)
      "dc-runtime/**",
      "*.config.{js,mjs,ts}",
      "next-env.d.ts",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Vendor boundaries (Daily SDK, Tavus payloads) use scoped `any` with explicit
      // per-line disables where unavoidable; keep the noise down, keep the signal.
      "@typescript-eslint/no-explicit-any": "warn",
      // Deliberate post-mount browser-state syncs (URL params, fetch-cycle resets) are the
      // standard Next.js SSR pattern; the new hooks rule flags them all — keep as advisory.
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
