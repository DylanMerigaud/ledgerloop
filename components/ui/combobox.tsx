"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A searchable single-select — a trigger button that opens a popover with a filter
 * input and a keyboard-navigable list. Used where a native `<select>` doesn't cut it:
 * the approver picker (13+ people, avatars) and long condition-value lists (vendors,
 * exception codes). Short enums stay plain `<select>`s.
 *
 * Controlled by `value`. Options carry a `label` (+ optional `sublabel`/`keywords` for
 * filtering, and a custom `render` for rich rows like an avatar). Closes on
 * select / Escape / click-outside; ↑/↓ move the highlight, Enter commits it.
 */

export type ComboboxOption = {
  value: string;
  label: string;
  /** Secondary line (e.g. a title) — also matched when filtering. */
  sublabel?: string;
  /** Extra words to match on (not shown). */
  keywords?: string;
  /** Custom row content; falls back to label + sublabel. */
  render?: () => React.ReactNode;
};

export const Combobox = ({
  value,
  onChange,
  options,
  placeholder = "Select…",
  invalid = false,
  testid,
  buttonClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  invalid?: boolean;
  testid?: string;
  buttonClassName?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0); // highlighted index in the filtered list
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.label} ${o.sublabel ?? ""} ${o.keywords ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [options, query]);

  // Reset the highlight whenever the filtered set changes, and focus the input on open.
  useEffect(() => {
    setActive(0);
  }, [query, open]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  // Close on a click outside the whole widget.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Node && !rootRef.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[active];
      if (opt) commit(opt.value);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={testid}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg bg-surface px-2.5 text-left text-[13px] outline-none ring-1 ring-inset transition-shadow focus:ring-2 focus:ring-accent-ring",
          invalid ? "ring-warn-line" : "ring-line-strong",
          buttonClassName,
        )}
      >
        <span
          className={cn("min-w-0 flex-1 truncate", !selected && "text-faint")}
        >
          {selected ? (selected.render?.() ?? selected.label) : placeholder}
        </span>
        <span aria-hidden className="shrink-0 text-faint">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg bg-surface shadow-lift ring-1 ring-inset ring-line">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search…"
            data-testid={testid ? `${testid}-search` : undefined}
            className="h-9 w-full border-b border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-faint"
          />
          <ul
            id={listId}
            role="listbox"
            className="scrollbar-slim max-h-56 overflow-y-auto py-1"
          >
            {filtered.length === 0 && (
              <li className="px-2.5 py-2 text-[12px] text-faint">No match.</li>
            )}
            {filtered.map((o, i) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  // Use mousedown so the click lands before the input's blur closes us.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(o.value);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink",
                    i === active ? "bg-accent-soft" : "hover:bg-subtle/60",
                  )}
                >
                  {o.render ? (
                    o.render()
                  ) : (
                    <span className="min-w-0 flex-1 truncate">
                      {o.label}
                      {o.sublabel && (
                        <span className="text-faint"> · {o.sublabel}</span>
                      )}
                    </span>
                  )}
                  {o.value === value && (
                    <span aria-hidden className="shrink-0 text-accent">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
