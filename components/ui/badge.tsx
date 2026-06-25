import { cn } from "@/lib/utils";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-subtle text-muted ring-1 ring-inset ring-line-strong",
  ok: "bg-ok-soft text-ok ring-1 ring-inset ring-ok-line/70",
  warn: "bg-warn-soft text-warn ring-1 ring-inset ring-warn-line/70",
  danger: "bg-danger-soft text-danger ring-1 ring-inset ring-danger-line/70",
  accent: "bg-accent-soft text-accent ring-1 ring-inset ring-accent/20",
};

export const Badge = ({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) => {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
};

export type { BadgeTone };
