import { cn } from "@/lib/utils";

/**
 * The surface primitive. A white panel that lifts off the cool page with a soft
 * layered shadow + hairline border. Rounded-2xl for the modern, soft register.
 */
export const Card = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <div
      className={cn(
        "rounded-2xl bg-surface shadow-card ring-1 ring-inset ring-line",
        className,
      )}
    >
      {children}
    </div>
  );
};

export const CardHeader = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-line px-5 py-3.5",
        className,
      )}
    >
      {children}
    </div>
  );
};

/**
 * The card's title — a real, readable heading (not the old 11px gray uppercase
 * eyebrow). Use <Eyebrow> for the small all-caps label where that's wanted.
 */
export const CardTitle = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <h3 className={cn("text-sm font-semibold text-ink", className)}>
      {children}
    </h3>
  );
};

/** Small uppercase section label, for sub-sections inside a card body. */
export const Eyebrow = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <h4
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-faint",
        className,
      )}
    >
      {children}
    </h4>
  );
};
