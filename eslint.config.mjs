import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint — the type-quality guardrail.
 *
 * The toolchain is deliberately lean (tsc + knip + prettier do the heavy lifting),
 * so this config is NARROW on purpose: it isn't a style linter (Prettier owns
 * formatting). It exists to stop the one thing tsc can't catch on its own — unsafe
 * `as` casts and `any` that quietly defeat the type system. Type-aware, so the
 * rules can reason about whether a cast is actually necessary.
 *
 * The escape hatch is explicit: a genuinely necessary boundary cast (e.g. adapting
 * a third-party type like Mastra's) must carry an inline `eslint-disable-next-line`
 * with a reason — so every remaining cast is a deliberate, reviewed decision, not
 * an accident.
 */
export default tseslint.config(
  {
    // Source only. Config/build files and generated output are out of scope.
    ignores: [
      "node_modules/**",
      ".next/**",
      "next-env.d.ts", // Next.js-generated; its triple-slash ref is not ours to change
      "eslint.config.mjs",
      "*.config.ts",
      "*.config.mjs",
      "postcss.config.mjs",
    ],
  },
  js.configs.recommended,
  // Type-aware recommended rules for all TS/TSX.
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── The point of this config: cast/any hygiene ──────────────────────────
      // A cast that TypeScript can prove is redundant is pure noise — remove it.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // No `any` — it silently turns off the type checker. Use `unknown` + a guard.
      "@typescript-eslint/no-explicit-any": "error",
      // The double-cast `x as unknown as T` defeats every safety check. Ban it;
      // the rare legitimate boundary cast must be an annotated, reviewed exception.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > TSAsExpression > TSUnknownKeyword, TSAsExpression[expression.type='TSAsExpression']",
          message:
            "Avoid `as unknown as T`. Narrow with a type guard, or if this is a necessary external-boundary cast, add an annotated eslint-disable explaining why.",
        },
      ],

      // ── Trim the recommended set to what's useful here (not a style police) ──
      // The unsafe-* family fires constantly at `unknown` boundaries we already
      // guard by hand (trace adapter, DB rows); they'd drown the signal. tsc strict
      // already covers the real holes. Keep the targeted cast/any rules above.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off",
      // React event handlers (onClick, onSubmit) legitimately take async functions;
      // their return is ignored by React. Keep the rule for real misuse (passing an
      // async fn where a sync one is contractually required) but allow JSX handlers.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // Mastra's step/tool `execute` and the workflow `.map()`/`.branch()` callbacks
      // are async by API contract even when a given body has no `await` — that's the
      // framework's shape, not a mistake. This rule fights it for no benefit.
      "@typescript-eslint/require-await": "off",
      // The `const { x, ...rest } = input` pattern that drops a few fields uses
      // `_`-prefixed names by convention; allow those, flag everything else.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Tests lean on small casts for fixtures — keep them honest but not noisy.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
