import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import noRelativeImportPaths from "eslint-plugin-no-relative-import-paths";
import checkFilePlugin from "eslint-plugin-check-file";
import eslintComments from "eslint-plugin-eslint-comments";
import prettierConfig from "eslint-config-prettier";
import { customRules } from "./config/eslint-rules/index";

/**
 * ESLint — aligned with the sibling ugc-workflow config, scaled to this repo.
 *
 * Prettier owns formatting; this owns what tsc can't catch on its own:
 *   • cast/null hygiene — no `any`, no bare `!`, no `as unknown as` (annotated
 *     exceptions only).
 *   • dead logic — no-unnecessary-condition / -assertion.
 *   • discipline — typed env over process.env, the logger over console, API_ROUTES
 *     over hardcoded paths, kebab-case files, absolute imports, no barrels, type
 *     over interface, organised imports.
 *   • React/Next/a11y correctness.
 *
 * The recommended set's noisier rules (unsafe-*, require-await) are off where they
 * fight legitimate patterns here (the `unknown` trace boundary; Mastra's async-by-
 * contract step signatures). Every eslint-disable must carry a reason.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "next-env.d.ts",
      "eslint.config.mts",
      "*.config.ts",
      "*.config.mjs",
      "*.config.mts",
      "postcss.config.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // React / hooks / a11y / Next.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11yPlugin,
      "@next/next": nextPlugin,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11yPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // The new JSX transform — no `import React` needed.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
  },

  // The main TypeScript rule set.
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      "no-relative-import-paths": noRelativeImportPaths,
      "check-file": checkFilePlugin,
      "eslint-comments": eslintComments,
      custom: customRules,
    },
    settings: { "import/resolver": { typescript: true } },
    rules: {
      // ── Cast / null / any hygiene ───────────────────────────────────────────
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      // No `x as T` assertions — narrow with a guard, validate with a schema, or use
      // `satisfies`. (Const assertions `as const` are still allowed.)
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",

      // ── Type style ──────────────────────────────────────────────────────────
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // ── Async safety ────────────────────────────────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // require-await stays ON globally (catches a forgotten await elsewhere); it's
      // turned off only for src/mastra/** below, where Mastra's step/tool `execute`
      // and workflow callbacks are async by API contract even without an await.
      // no-unsafe-* are LEFT ON (error, from recommendedTypeChecked) — stricter
      // than ugc. They catch real unguarded `unknown` access; the genuine
      // `unknown` boundaries (trace adapter, DB rows) narrow through helpers.

      // ── Imports ─────────────────────────────────────────────────────────────
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import/no-default-export": "error",
      "no-relative-import-paths/no-relative-import-paths": [
        "error",
        { allowSameFolder: false, rootDir: ".", prefix: "@" },
      ],

      // ── Style ───────────────────────────────────────────────────────────────
      "func-style": ["error", "expression", { allowArrowFunctions: true }],
      "prefer-arrow-callback": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > TSAsExpression > TSUnknownKeyword, TSAsExpression[expression.type='TSAsExpression']",
          message:
            "Avoid `as unknown as T`. Narrow with a type guard, or annotate a necessary boundary cast with an eslint-disable + reason.",
        },
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Use the typed `env` from '@/lib/env' instead of process.env. (Scripts/eval/sanity are exempt.)",
        },
      ],

      // ── Custom rules ────────────────────────────────────────────────────────
      "custom/no-console-use-logger": "error",
      "no-console": "off",
      "custom/no-index-files": "error",
      "custom/prefer-use-event-callback": "error",
      "custom/enforce-api-routes": "error",

      // ── Comments ────────────────────────────────────────────────────────────
      "eslint-comments/require-description": "error",

      // ── File naming ─────────────────────────────────────────────────────────
      "check-file/filename-naming-convention": [
        "error",
        { "**/*.{ts,tsx}": "KEBAB_CASE" },
        { ignoreMiddleExtensions: true },
      ],
      "check-file/folder-naming-convention": [
        "error",
        { "{app,components,lib,db,hooks,config,src}/**/!(\\(*\\))": "KEBAB_CASE" },
      ],
    },
  },

  // env.ts is the ONE place process.env is read.
  {
    files: ["lib/env.ts"],
    rules: { "no-restricted-syntax": "off" },
  },

  // Route handlers + the API_ROUTES definition itself own the API path strings.
  {
    files: ["app/api/**/*.ts", "lib/api-routes.ts"],
    rules: { "custom/enforce-api-routes": "off" },
  },
  {
    files: ["lib/logger.ts"],
    rules: { "custom/no-console-use-logger": "off" },
  },

  // Next.js pages/layouts must default-export; configs too.
  {
    files: ["app/**/{page,layout,not-found,opengraph-image,error}.tsx"],
    rules: { "import/no-default-export": "off" },
  },

  // Standalone tsx entrypoints (scripts, DB seed, the sanity check, the eval
  // harness) read process.env directly and print to the terminal — that's their job.
  {
    files: [
      "scripts/**/*.ts",
      "db/seed.ts",
      "src/mastra/sanity.ts",
      "eval/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
      "no-console": "off",
      "custom/no-console-use-logger": "off",
      "custom/enforce-api-routes": "off",
    },
  },

  // ESLint rule-authoring compares against the TSESTree AST string types — the
  // enum-comparison + a few type-checked rules don't apply to that style.
  {
    files: ["config/eslint-rules/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "custom/no-index-files": "off",
      // jiti loads these by relative path before the @/ alias exists.
      "no-relative-import-paths/no-relative-import-paths": "off",
    },
  },

  // Mastra workflows/agents/tools: `execute` and the workflow `.map()`/`.branch()`
  // callbacks are async by Mastra's API contract even when a given body has no
  // await — that's the framework shape, not a mistake. Scoped here, not global.
  {
    files: ["src/mastra/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },

  // Tests: `!` and `any` on just-defined fixtures are provably safe; keep the
  // cast/logic rules (real safety) but relax the ceremony ones. `node:test`'s
  // `test()` returns a promise the runner owns, so floating-promises is noise here.
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-floating-promises": "off",
      // Mock implementations satisfy async interfaces with no await — fine in tests.
      "@typescript-eslint/require-await": "off",
    },
  },

  // Prettier last — turn off all formatting rules.
  prettierConfig,
);
