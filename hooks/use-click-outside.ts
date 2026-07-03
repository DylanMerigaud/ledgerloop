import { useEffect, type RefObject } from "react";

import { useEventCallback } from "@/hooks/use-event-callback";

/**
 * Call `onOutside` when a mousedown lands outside `ref`, while `active`. One place for
 * the "click away closes this" pattern (a popover, a combobox), so each caller doesn't
 * re-implement the document listener + `contains` check + cleanup. The handler is
 * wrapped so a fresh closure each render doesn't re-subscribe; it attaches only while
 * active, so a closed overlay isn't paying for a global listener.
 */
export const useClickOutside = (
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
): void => {
  const handler = useEventCallback(onOutside);
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (
        target instanceof Node &&
        ref.current &&
        !ref.current.contains(target)
      )
        handler();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, active, handler]);
};
