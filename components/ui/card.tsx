import { cn } from "@/lib/utils";

export const Card = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <div
      className={cn("rounded-xl bg-surface shadow-card ring-line", className)}
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
    <div className={cn("border-b border-line px-4 py-3", className)}>
      {children}
    </div>
  );
};

export const CardTitle = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <h3
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-muted",
        className,
      )}
    >
      {children}
    </h3>
  );
};
