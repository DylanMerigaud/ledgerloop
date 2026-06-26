"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * App-wide TanStack Query provider. One client per browser session (created in
 * state so it's stable across re-renders, never re-created on hot reload). The oRPC
 * procedures are consumed via `orpc.<proc>.queryOptions()/mutationOptions()` (see
 * lib/orpc/client.ts) under this provider.
 */
export const QueryProvider = ({ children }: { children: React.ReactNode }) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};
