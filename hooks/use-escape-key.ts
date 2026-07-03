import { useEffect } from "react";

import { useEventCallback } from "@/hooks/use-event-callback";

/**
 * Call `onEscape` when Escape is pressed, while `active`. One place for the "Escape
 * closes this overlay" pattern (a drawer, a panel, a popover), so each caller doesn't
 * re-implement the keydown listener + cleanup. The handler is wrapped so a fresh
 * closure each render doesn't re-subscribe; the listener attaches only while active.
 */
export const useEscapeKey = (active: boolean, onEscape: () => void): void => {
  const handler = useEventCallback(onEscape);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, handler]);
};
