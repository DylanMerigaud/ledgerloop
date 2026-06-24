import { useLayoutEffect, useRef } from "react";

/**
 * A stable callback whose identity never changes but which always sees the latest
 * closure — the fix for the `useCallback` stale-closure / re-render churn. Use this
 * for event handlers instead of `useCallback` (enforced by the custom ESLint rule).
 */
export const useEventCallback = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic callback needs `any` args/return for full flexibility
  T extends (...args: any[]) => any,
>(
  fn: T,
): T => {
  const ref = useRef<T>(fn);

  useLayoutEffect(() => {
    ref.current = fn;
  });

  return useRef<T>(((...args: Parameters<T>) => ref.current(...args)) as T)
    .current;
};
