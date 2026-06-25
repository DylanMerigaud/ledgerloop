import { cn } from "@/lib/utils";

/**
 * The one button. Every clickable CTA in the app routes through here so weight,
 * radius, focus ring, and motion stay identical everywhere — before this, each
 * screen hand-rolled its own button classes and they drifted.
 *
 * Variants map to the app's actual roles:
 *   primary — the accent CTA (Run, Edit, Discover)
 *   ghost   — a quiet bordered action (Revert, secondary)
 *   ok      — the approve gate (green)
 *   danger  — the reject gate (red, bordered)
 */
type Variant = "primary" | "ghost" | "ok" | "danger";
type Size = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium " +
  "transition-all duration-150 outline-none focus-visible:ring-2 " +
  "focus-visible:ring-accent-ring focus-visible:ring-offset-1 " +
  "focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg shadow-accent hover:bg-accent-hover active:translate-y-px",
  ghost:
    "bg-surface text-ink ring-1 ring-inset ring-line-strong hover:bg-subtle active:translate-y-px",
  ok: "bg-ok text-white shadow-card hover:opacity-90 active:translate-y-px",
  danger:
    "bg-surface text-danger ring-1 ring-inset ring-danger-line hover:bg-danger-soft active:translate-y-px",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

export const Button = ({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) => {
  return (
    <button
      type="button"
      disabled={disabled ?? loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
};

const Spinner = () => {
  return (
    <span
      aria-hidden
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
};
