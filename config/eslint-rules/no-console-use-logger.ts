import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `${name}`);

/**
 * Disallow `console.*` in app code — use the logger (`@/lib/logger`) instead, so
 * logging has one shape and one place to wire up Sentry/PostHog later. Scripts,
 * the sanity check, and the eval harness are exempted in the ESLint config (they
 * legitimately print to the terminal).
 */
export const noConsoleUseLogger = createRule({
  name: "no-console-use-logger",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: { description: "Disallow console usage, use the logger instead" },
    messages: {
      noConsole:
        "Do not use console.{{method}}(). Use 'log.{{method}}()' from '@/lib/logger' instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "console" &&
          node.property.type === "Identifier"
        ) {
          context.report({
            node,
            messageId: "noConsole",
            data: { method: node.property.name },
          });
        }
      },
    };
  },
});
