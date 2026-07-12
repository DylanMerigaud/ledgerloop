// Relative imports here on purpose: jiti loads this from disk to build the ESLint
// config, before the TS `@/` path alias is available. (no-restricted-imports is
// disabled for this dir in the config.)
import { enforceApiRoutes } from "./enforce-api-routes";

/**
 * This repo's app-specific ESLint rules, exposed as a flat-config plugin under the
 * `custom-local` namespace. The generic rules (no-console-use-logger, no-index-files,
 * prefer-use-event-callback, no-emdash-in-text) now ship in @dylanmerigaud/config
 * under the `custom` namespace; only enforce-api-routes is specific to ledgerloop.
 */
export const customLocalRules = {
  rules: {
    "enforce-api-routes": enforceApiRoutes,
  },
};
