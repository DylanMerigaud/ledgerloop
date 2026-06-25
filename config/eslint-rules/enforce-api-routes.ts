import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `${name}`);

/**
 * Forbid hardcoded `/api/...` path strings — import from `API_ROUTES`
 * (`@/lib/api-routes`) instead, so the client and the route handlers share one
 * source of truth and a rename is a single edit. The definition file itself and
 * the route handlers (app/api/**) are exempted in the ESLint config.
 */
const API_PATH = /^\/api\//;

export const enforceApiRoutes = createRule({
  name: "enforce-api-routes",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Enforce API paths come from the API_ROUTES constant",
    },
    schema: [],
    messages: {
      useApiRoutes:
        "Hardcoded API path '{{ path }}'. Import and use API_ROUTES from '@/lib/api-routes' instead.",
    },
  },
  create: (context) => {
    const check = (node: TSESTree.Literal) => {
      if (typeof node.value !== "string" || !API_PATH.test(node.value)) return;
      context.report({
        node,
        messageId: "useApiRoutes",
        data: { path: node.value },
      });
    };
    return {
      Literal: check,
    };
  },
});
