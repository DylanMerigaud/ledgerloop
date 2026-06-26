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

  // The wrapper has T's exact call signature but TS can't infer it's assignable to
  // the generic T itself — the one boundary assertion unavoidable in this utility.
  // The return is `any` only because T's return is `any` (same generic-callback
  // reason as the disable above); args/return are typed via Parameters/ReturnType.
  const stable = (...args: Parameters<T>): ReturnType<T> =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- T's return is `any` by the generic constraint above
    ref.current(...args);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic wrapper → T: the call signature matches; T just can't be proven assignable
  return useRef<T>(stable as T).current;
};
