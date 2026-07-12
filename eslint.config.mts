import { next } from "@dylanmerigaud/config/eslint/next";

import { customLocalRules } from "./config/eslint-rules/index";

/**
 * ESLint. The shared preset (@dylanmerigaud/config, `next`) owns the whole base:
 * cast/null hygiene, typed env over process.env, the logger over console, no
 * barrels, type over interface, React/hooks/a11y/Next, and the generic custom
 * rules (no-emdash-in-text, no-console-use-logger, no-index-files,
 * prefer-use-event-callback). This file adds only what is specific to ledgerloop,
 * under the `custom-local` plugin namespace:
 *   • enforce-api-routes: hardcoded `/api/...` paths must come from API_ROUTES.
 *   • the Mastra require-await exemption (its step/tool `execute` and workflow
 *     callbacks are async by API contract even without an await).
 *   • the eval/sanity entrypoint relaxations the shared scripts block doesn't cover.
 *
 * ledgerloop adopts the full opinionated @dylanmerigaud/config layer (perfectionist
 * import/member sorting, eslint-plugin-unicorn, the stricter @eslint-react rules):
 * the code satisfies those rules rather than opting out. The only disabling below
 * is the handful of framework truths (Mastra, rule-authoring code, eval/sanity
 * entrypoints) plus any targeted per-line disable that carries its own reason.
 */
export default [
  ...next({ tsconfigRootDir: import.meta.dirname }),

  // enforce-api-routes on repo-wide; route handlers and the API_ROUTES definition
  // itself own the raw `/api/...` strings, so they are exempted just below.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "custom-local": customLocalRules },
    rules: { "custom-local/enforce-api-routes": "error" },
  },
  {
    files: ["app/api/**/*.ts", "lib/api-routes.ts"],
    rules: { "custom-local/enforce-api-routes": "off" },
  },

  // Mastra workflows/agents/tools: `execute` and the workflow `.map()`/`.branch()`
  // callbacks are async by Mastra's API contract even when a given body has no
  // await, that is the framework shape, not a mistake. Scoped here, not global.
  {
    files: ["src/mastra/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },

  // Standalone tsx entrypoints beyond the shared scripts/db-seed block: the sanity
  // check and the eval harness read process.env directly, print to the terminal,
  // and don't touch API paths. (The shared preset already relaxes scripts/** and
  // db/seed.ts; this extends the same treatment to eval/** and sanity.)
  {
    files: ["src/mastra/sanity.ts", "eval/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "no-console": "off",
      "custom/no-console-use-logger": "off",
      "custom-local/enforce-api-routes": "off",
    },
  },
  // The shared scripts/** + db/seed.ts relaxation doesn't turn off the local
  // enforce-api-routes rule (it lives in the shared preset which can't know about
  // it), so do that here for those same paths.
  {
    files: ["scripts/**/*.ts", "db/seed.ts"],
    rules: { "custom-local/enforce-api-routes": "off" },
  },

  // ESLint rule-authoring code: the barrel is the plugin entrypoint (loaded by
  // jiti), and rule bodies compare against TSESTree's string AST types where the
  // enum-comparison check doesn't apply.
  {
    files: ["config/eslint-rules/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "custom/no-index-files": "off",
    },
  },
  // src/mastra/index.ts is Mastra's required framework entry point (the shared
  // preset bans barrels; the old local no-index-files rule whitelisted this exact
  // path, so keep exempting it to preserve prior behavior).
  {
    files: ["src/mastra/index.ts"],
    rules: { "custom/no-index-files": "off" },
  },
];
