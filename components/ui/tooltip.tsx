"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

/**
 * Tooltip, on Radix so positioning, collision-avoidance, the arrow, the portal, and
 * a11y are handled for us (no hand-rolled absolute bubbles that clip). Styled in the
 * app's register: ink surface, white text, the lift shadow. Wrap a subtree in
 * `<TooltipProvider>` once (or pass `delayDuration` per Tooltip).
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = ({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) => {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-max max-w-[260px] rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium leading-snug text-white shadow-lift",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-ink" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
};
