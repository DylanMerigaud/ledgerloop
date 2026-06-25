import * as path from "node:path";

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `${name}`);

/**
 * Disallow `index.ts(x)` barrel files. Export directly from the module file
 * instead — barrels obscure where things live and create import cycles. (One
 * exception: the ESLint custom-rules directory needs its own index.)
 */
const ALLOWED = new Set([
  "config/eslint-rules/index.ts",
  "src/mastra/index.ts", // Mastra's required framework entry point
]);

export const noIndexFiles = createRule({
  name: "no-index-files",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: { description: "Disallow index/barrel files" },
    schema: [],
    messages: {
      avoidIndexFile:
        "Avoid index/barrel files. Export directly from the module file instead.",
    },
  },
  create: (context) => {
    const basename = path.basename(context.filename);
    if (!/^index\.(ts|tsx|js|jsx)$/.test(basename)) return {};

    const rel = path
      .relative(process.cwd(), context.filename)
      .split(path.sep)
      .join("/");
    if (ALLOWED.has(rel)) return {};

    return {
      Program(node) {
        context.report({ node, messageId: "avoidIndexFile" });
      },
    };
  },
});
