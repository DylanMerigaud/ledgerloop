/**
 * The app's REST API paths in one place (enforced by the custom enforce-api-routes
 * ESLint rule). Most of the backend moved to the typed oRPC API under /rpc (see
 * lib/orpc/*); the only plain REST endpoint left is the invoice PDF, which serves
 * binary bytes — better as a normal route than an RPC procedure.
 */
export const API_ROUTES = {
  /** GET the real invoice PDF the vision model reads, by seeded invoice id. */
  pdf: (id: string): string => `/api/pdf/${encodeURIComponent(id)}`,
} as const;
