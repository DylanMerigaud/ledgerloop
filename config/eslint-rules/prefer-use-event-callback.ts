import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `${name}`);

/**
 * Prefer `useEventCallback` (from `@/hooks/use-event-callback`) over `useCallback`
 * — it gives a stable identity that always sees the latest closure, avoiding stale
 * closures and dependency-array churn.
 */
export const preferUseEventCallback = createRule({
  name: "prefer-use-event-callback",
  defaultOptions: [],
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer useEventCallback over useCallback to prevent stale closures",
    },
    schema: [],
    messages: {
      preferUseEventCallback:
        "Use 'useEventCallback' from '@/hooks/use-event-callback' instead of '{{ hook }}'.",
    },
  },
  create: (context) => {
    let hasUseCallbackImport = false;
    let hasReactImport = false;

    return {
      ImportDeclaration(node) {
        if (node.source.value === "react") {
          hasReactImport = true;
          const useCallbackSpecifier = node.specifiers.find(
            (s): s is TSESTree.ImportSpecifier =>
              s.type === "ImportSpecifier" &&
              s.imported.type === "Identifier" &&
              s.imported.name === "useCallback",
          );
          if (useCallbackSpecifier) hasUseCallbackImport = true;
        }
      },
      CallExpression(node) {
        let hookName: string | null = null;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "useCallback" &&
          hasUseCallbackImport
        ) {
          hookName = "useCallback";
        }
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "React" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "useCallback" &&
          hasReactImport
        ) {
          hookName = "React.useCallback";
        }
        if (hookName) {
          context.report({
            node,
            messageId: "preferUseEventCallback",
            data: { hook: hookName },
          });
        }
      },
    };
  },
});
