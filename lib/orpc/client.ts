import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import type { Router } from "@/lib/orpc/router";

/**
 * The browser client for the oRPC API — typed entirely from the server `Router`, so
 * `client.onboarding()` / `client.editWorkflow(...)` / `client.run(...)` return the
 * exact server types with zero `res.json() as T`. Talks to the catch-all handler
 * mounted at /rpc.
 */
const link = new RPCLink({
  // Relative to the current origin in the browser; absolute on the server (SSR).
  url:
    typeof window === "undefined"
      ? "http://localhost/rpc"
      : `${window.location.origin}/rpc`,
});

export const client: RouterClient<Router> = createORPCClient(link);

/** TanStack Query bindings for the client — `orpc.<proc>.queryOptions()` /
    `.mutationOptions()`, fully typed from the same Router. */
export const orpc = createTanstackQueryUtils(client);
