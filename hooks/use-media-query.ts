import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and re-render when it flips. SSR-safe: starts
 * `false` on the server / first paint (no `window`), then syncs on mount — so a
 * server-rendered tree matches the client's initial HTML and updates after hydration.
 */
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
};
