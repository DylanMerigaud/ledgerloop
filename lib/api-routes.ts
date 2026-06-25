/**
 * The app's API endpoints, in one place.
 *
 * The client fetches these and the route handlers define them — keeping the paths
 * here means the two sides can't drift, a rename is one edit, and there are no
 * magic `/api/...` strings scattered across components. A custom ESLint rule
 * (`custom/enforce-api-routes`) forbids hardcoding these paths anywhere else.
 *
 * (This is the SPA-appropriate version of a `ROUTES` constant: there's no page
 * routing to centralise, but the fetch endpoints are exactly that kind of shared
 * string.)
 */
export const API_ROUTES = {
  /** POST — run the P2P pipeline for one invoice (streams the trace). */
  run: "/api/run",
  /** POST — derive an approval workflow from the client's org. */
  onboarding: "/api/onboarding",
  /** POST — propose a conversational edit to a workflow. */
  workflowEdit: "/api/workflow/edit",
} as const;
