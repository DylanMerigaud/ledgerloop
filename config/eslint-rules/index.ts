// Relative imports here on purpose: jiti loads this from disk to build the ESLint
// config, before the TS `@/` path alias is available. (no-relative-import-paths is
// disabled for this dir in the config.)
import { enforceApiRoutes } from "./enforce-api-routes";
import { noConsoleUseLogger } from "./no-console-use-logger";
import { noIndexFiles } from "./no-index-files";
import { preferUseEventCallback } from "./prefer-use-event-callback";

/** The project's custom ESLint rules, exposed as a flat-config plugin. */
export const customRules = {
  rules: {
    "no-console-use-logger": noConsoleUseLogger,
    "no-index-files": noIndexFiles,
    "prefer-use-event-callback": preferUseEventCallback,
    "enforce-api-routes": enforceApiRoutes,
  },
};
