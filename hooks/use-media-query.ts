import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and re-render when it flips. SSR-safe: starts
 * `false` on the server / first paint (no `window`), then syncs on mount, so a
 * server-rendered tree matches the client's initial HTML and updates after hydration.
 */
// eslint-disable-next-line unicorn/consistent-boolean-name -- a React hook returning boolean must keep the `use` prefix; it cannot be renamed to an is/has form.
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- SSR-safe sync: window.matchMedia can't be read during render/on the server, so the real value is read once on mount (and on query change). One mount-time render, by design.
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
};
