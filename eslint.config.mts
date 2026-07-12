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
 * The final block turns OFF the opinionated rule layer that @dylanmerigaud/config
 * 0.2.x newly introduced (perfectionist import sorting, most of eslint-plugin-
 * unicorn, and the stricter @eslint-react rules). See its `reason:` for why: this
 * change is a config-plumbing SWAP that preserves ledgerloop's prior effective
 * lint surface; adopting that opinionated layer is a separate, deliberate effort.
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

  // ── Opinionated-layer opt-OUT ──────────────────────────────────────────────
  // reason: @dylanmerigaud/config 0.2.x added a large opinionated layer on top of
  // the base ledgerloop already used: eslint-plugin-perfectionist (import/member
  // sorting), most of eslint-plugin-unicorn, and the stricter @eslint-react rules
  // (set-state-in-effect, no-array-index-key, purity, ...). ledgerloop's existing
  // code predates all of them, so they fire ~700 times. This retrofit is a config
  // SWAP whose contract is "preserve ledgerloop's prior effective lint surface",
  // not a code refactor: turning these on means hundreds of hand edits (renaming
  // public boolean props, restructuring effects, changing sort semantics) plus
  // some genuine false positives, which is out of scope here and which eslint
  // --fix cannot do safely (it introduced fresh type errors). They are disabled
  // as ONE reviewed block so nothing is loosened silently; adopting this layer
  // incrementally is a separate, deliberate task. `custom/no-empty-string-fallback`
  // is included: ledgerloop has no `@/lib/utils/invariant` helper (the fix the
  // rule points to) and uses `?? ""` as legitimate string normalization.
  // `custom/no-vibe-coded-naming` is intentionally LEFT ON (it fires 0 times).
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@eslint-react/naming-convention-ref-name": "off",
      "@eslint-react/no-array-index-key": "off",
      "@eslint-react/purity": "off",
      "@eslint-react/set-state-in-effect": "off",
      "@eslint-react/static-components": "off",
      "@eslint-react/use-state": "off",
      "custom/no-empty-string-fallback": "off",
      "perfectionist/sort-imports": "off",
      "perfectionist/sort-named-exports": "off",
      "perfectionist/sort-named-imports": "off",
      "unicorn/catch-error-name": "off",
      "unicorn/consistent-boolean-name": "off",
      "unicorn/consistent-conditional-object-spread": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/escape-case": "off",
      "unicorn/explicit-length-check": "off",
      "unicorn/isolated-functions": "off",
      "unicorn/max-nested-calls": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/no-break-in-nested-loop": "off",
      "unicorn/no-chained-comparison": "off",
      "unicorn/no-computed-property-existence-check": "off",
      "unicorn/no-constant-zero-expression": "off",
      "unicorn/no-declarations-before-early-exit": "off",
      "unicorn/no-for-each": "off",
      "unicorn/no-negated-array-predicate": "off",
      "unicorn/no-negated-condition": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/no-top-level-assignment-in-function": "off",
      "unicorn/no-unreadable-for-of-expression": "off",
      "unicorn/no-unsafe-string-replacement": "off",
      "unicorn/no-useless-coercion": "off",
      "unicorn/no-useless-collection-argument": "off",
      "unicorn/no-useless-template-literals": "off",
      "unicorn/no-zero-fractions": "off",
      "unicorn/numeric-separators-style": "off",
      "unicorn/prefer-at": "off",
      "unicorn/prefer-await": "off",
      "unicorn/prefer-code-point": "off",
      "unicorn/prefer-direct-iteration": "off",
      "unicorn/prefer-else-if": "off",
      "unicorn/prefer-export-from": "off",
      "unicorn/prefer-global-number-constants": "off",
      "unicorn/prefer-includes-over-repeated-comparisons": "off",
      "unicorn/prefer-iterator-to-array": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-split-limit": "off",
      "unicorn/prefer-spread": "off",
      "unicorn/prefer-string-raw": "off",
      "unicorn/prefer-string-repeat": "off",
      "unicorn/prefer-string-replace-all": "off",
      "unicorn/prefer-switch": "off",
      "unicorn/prefer-unicode-code-point-escapes": "off",
      "unicorn/prefer-url-href": "off",
      "unicorn/require-array-sort-compare": "off",
      "unicorn/require-css-escape": "off",
      "unicorn/switch-case-braces": "off",
    },
  },
];
