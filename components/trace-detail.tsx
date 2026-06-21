import { Badge } from "@/components/ui/badge";
import { formatMoney, formatPct, humanize } from "@/lib/format";
import type {
  MatchResult,
  ApprovalDecision,
  ReconResult,
  Investigation,
} from "@/lib/schema";

/**
 * Rich, type-aware detail for a completed stage. Each stage emits a different
 * validated payload (MatchResult / ApprovalDecision / ReconResult); we sniff a
 * discriminating field and render the matching view. This is what turns the trace
 * from a log into something a CTO can read the *reasoning* out of — the exact
 * exception lines, the approval drivers, the GL posting.
 */

export function TraceDetail({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  if ("verdict" in d && "exceptions" in d)
    return <MatchDetail match={d as unknown as MatchResult} />;
  if ("recommendation" in d && "toolsUsed" in d)
    return <InvestigationDetail inv={d as unknown as Investigation} />;
  if ("tier" in d && "autoApproved" in d)
    return <ApprovalDetail decision={d as unknown as ApprovalDecision} />;
  if ("posted" in d && "glEntries" in d)
    return <ReconDetail recon={d as unknown as ReconResult} />;
  return null;
}

/** The exception investigator's recommendation — the one agentic output. */
function InvestigationDetail({ inv }: { inv: Investigation }) {
  const tone =
    inv.recommendation === "likely_legitimate"
      ? "ok"
      : inv.recommendation === "likely_overcharge"
        ? "danger"
        : "warn";
  return (
    <div className="space-y-1.5">
      <Row label="Recommendation">
        <Badge tone={tone}>{humanize(inv.recommendation)}</Badge>
      </Row>
      {inv.toolsUsed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted">Records pulled:</span>
          {inv.toolsUsed.map((t) => (
            <span
              key={t}
              className="rounded-full bg-canvas px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-inset ring-line"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MatchDetail({ match }: { match: MatchResult }) {
  if (match.exceptions.length === 0) {
    return (
      <Row label="Match">
        {match.matchType === "three_way" ? "3-way" : "2-way"} · all lines
        reconcile
      </Row>
    );
  }
  return (
    <div className="space-y-1.5">
      {match.exceptions.map((e, i) => (
        <div
          key={`${e.sku}-${e.code}-${i}`}
          className="rounded-lg bg-danger-soft/40 px-2.5 py-1.5 ring-1 ring-inset ring-danger-line/50"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-medium text-ink">
              {e.sku}
            </span>
            <Badge tone="danger">{humanize(e.code)}</Badge>
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink/80">
            {e.message}
          </p>
          {e.variancePct > 0 && (
            <p className="mt-0.5 text-[11px] text-muted tnum">
              variance {formatPct(e.variancePct)}
              {e.expectedValue != null && e.invoiceValue != null
                ? ` · expected ${e.expectedValue} vs invoiced ${e.invoiceValue}`
                : ""}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ApprovalDetail({ decision }: { decision: ApprovalDecision }) {
  return (
    <div className="space-y-1">
      <Row label="Tier">
        <Badge
          tone={
            decision.tier === "blocked"
              ? "danger"
              : decision.autoApproved
                ? "ok"
                : "warn"
          }
        >
          {humanize(decision.tier)}
        </Badge>
      </Row>
      {decision.exceptionAmount > 0 && (
        <Row label="At stake">
          <span className="tnum">
            {formatMoney(decision.exceptionAmount, decision.currency)}
          </span>
        </Row>
      )}
      {decision.maxVariancePct > 0 && (
        <Row label="Max variance">
          <span className="tnum">{formatPct(decision.maxVariancePct)}</span>
        </Row>
      )}
    </div>
  );
}

function ReconDetail({ recon }: { recon: ReconResult }) {
  // Awaiting is a pause (amber), not a failure; posted is success; rejected/
  // blocked are red. Drive the badge off the precise outcome.
  const tone =
    recon.outcome === "posted"
      ? "ok"
      : recon.outcome === "awaiting"
        ? "warn"
        : "danger";
  const label =
    recon.outcome === "posted"
      ? "Posted"
      : recon.outcome === "awaiting"
        ? "Awaiting approval"
        : recon.outcome === "rejected"
          ? "Rejected"
          : "Blocked";
  return (
    <div className="space-y-1">
      <Row label="Status">
        <Badge tone={tone}>{label}</Badge>
      </Row>
      {recon.erpRef && (
        <Row label="ERP ref">
          <span className="font-mono text-[11px]">{recon.erpRef}</span>
        </Row>
      )}
      {recon.glEntries.length > 0 && (
        <div className="mt-1 overflow-hidden rounded-lg ring-1 ring-inset ring-line">
          <table className="w-full text-[11px]">
            <tbody>
              {recon.glEntries.map((g, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="px-2 py-1 text-ink/80">{g.account}</td>
                  <td className="px-2 py-1 text-right tnum text-ink">
                    {g.debit > 0 ? formatMoney(g.debit, recon.currency) : ""}
                  </td>
                  <td className="px-2 py-1 text-right tnum text-ink">
                    {g.credit > 0 ? formatMoney(g.credit, recon.currency) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="text-muted">{label}</span>
      <span className="text-ink">{children}</span>
    </div>
  );
}
