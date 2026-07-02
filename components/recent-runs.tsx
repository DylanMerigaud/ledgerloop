"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { outcomeDot, type Outcome } from "@/lib/display";
import { formatDuration } from "@/lib/format";
import { orpc } from "@/lib/orpc/client";

/**
 * The "Recent runs" panel, the audit trail made visible.
 *
 * Every pipeline run is persisted append-only (see db/runs.ts); this lists the
 * latest ones (newest first) and lets you REPLAY one: clicking a row fetches its
 * stored trace and re-renders it through the same trace + graph components a live
 * run uses, with NO pipeline execution (zero model tokens). The list is cleared by
 * the nightly reset, so it shows what's been processed since the last reset.
 *
 * Read-only over the typed oRPC `history` / `replayRun` procedures. A failed or
 * empty audit log degrades to a quiet "no runs yet", it never blocks the queue.
 */

/** Map a stored verdict/outcome to the shared Outcome display vocabulary (the same
 *  dots the queue uses), so history reads consistently with the live run. */
const toOutcome = (verdict: string, outcome: string): Outcome => {
  if (
    verdict === "duplicate" ||
    outcome === "blocked" ||
    outcome === "rejected"
  ) {
    return "blocked";
  }
  if (outcome === "awaiting") return "needs-approval";
  if (outcome === "posted") return "reconciled";
  return "pending";
};

/** Compact "Xs ago" / "Xm ago" from an ISO timestamp, for the row's right edge. */
const timeAgo = (iso: string): string => {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
};

export const RecentRuns = ({
  /** Open a stored run by navigating to its `?run=<id>`. The dashboard's URL effect
      does the actual fetch + replay, so a click here is just navigation. */
  onOpen,
  /** Disabled while a live run is in flight, opening one would clobber it. */
  disabled,
}: {
  onOpen: (id: string) => void;
  disabled: boolean;
}) => {
  const history = useQuery(orpc.history.queryOptions());

  const runs = history.data?.runs ?? [];

  // "N more ↓" scroll affordance: the list scrolls (max-h-56) but gives no cue that
  // rows continue below. Mirror the queue's pill, measure the hidden rows and offer
  // a click that scrolls down. Hidden once at the bottom.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    setHiddenBelow(remaining < 8 ? 0 : remaining);
  };
  useEffect(() => {
    measure();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [runs.length]);

  const ROW_PX = 45; // approx height of one run row
  const moreCount =
    hiddenBelow > 0 ? Math.max(1, Math.round(hiddenBelow / ROW_PX)) : 0;

  const open = (id: string) => {
    if (disabled) return;
    onOpen(id);
  };

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Recent runs</CardTitle>
        <span className="text-[11px] text-muted tnum">
          {runs.length > 0 ? `${runs.length} logged` : "audit log"}
        </span>
      </CardHeader>
      {runs.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-faint">
          No runs yet. Run an invoice and it&apos;ll be logged here. The trail
          resets daily.
        </p>
      ) : (
        <div className="relative min-h-0">
          <ul
            ref={listRef}
            onScroll={measure}
            className="scrollbar-slim max-h-40 divide-y divide-line overflow-y-auto"
          >
            {runs.map((r) => {
              const outcome = toOutcome(r.verdict, r.outcome);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    data-testid={`run-history-${r.id}`}
                    onClick={() => open(r.id)}
                    disabled={disabled}
                    aria-disabled={disabled}
                    className={`flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-subtle/70 ${
                      disabled ? "cursor-not-allowed opacity-40" : ""
                    }`}
                  >
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full ring-2 ring-surface"
                      style={{ backgroundColor: outcomeDot(outcome) }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] text-ink">
                        {r.invoiceNumber}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {r.verdict} · {r.outcome} ·{" "}
                        {formatDuration(r.durationMs)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-faint tnum">
                      {timeAgo(r.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {moreCount > 0 && (
            <button
              type="button"
              onClick={() =>
                listRef.current?.scrollBy({
                  top: listRef.current.clientHeight * 0.8,
                  behavior: "smooth",
                })
              }
              className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1 rounded-full bg-ink/85 px-3 py-1 text-[11px] font-medium text-white shadow-lift backdrop-blur transition-opacity hover:bg-ink"
            >
              {moreCount} more
              <span aria-hidden>↓</span>
            </button>
          )}
        </div>
      )}
    </Card>
  );
};
