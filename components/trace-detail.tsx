import { Badge } from "@/components/ui/badge";
import { WorkflowGraph } from "@/components/workflow-graph";
import type { ApprovalWorkflow } from "@/lib/approval-workflow";
import { formatMoney, formatPct, humanize } from "@/lib/format";
import type { MatchResult, ReconResult, Investigation } from "@/lib/schema";

/**
 * Rich, type-aware detail for a completed stage. Each stage emits a different
 * validated payload (MatchResult / ApprovalDecision / ReconResult); we sniff a
 * discriminating field and render the matching view. This is what turns the trace
 * from a log into something a CTO can read the *reasoning* out of — the exact
 * exception lines, the approval drivers, the GL posting.
 */

/**
 * The trace carries each stage's already-Zod-validated output as `unknown`. We
 * narrow it with type guards on the discriminating fields — not casts — so the
 * render branch and the prop type are checked together. (A guard that returns
 * `d is T` documents AND verifies the shape; a cast would only assert it.)
 */
function has(d: object, ...keys: string[]): boolean {
  return keys.every((k) => k in d);
}
const isMatch = (d: object): d is MatchResult =>
  has(d, "verdict", "exceptions");
const isInvestigation = (d: object): d is Investigation =>
  has(d, "recommendation", "toolsUsed");
const isWorkflowRun = (d: object): d is WorkflowRunData =>
  has(d, "workflow", "steps");
const isApprovalSummary = (d: object): d is ApprovalSummary =>
  has(d, "outcome", "steps");
const isRecon = (d: object): d is ReconResult => has(d, "posted", "glEntries");

export function TraceDetail({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") return null;
  const d = data;

  if (isMatch(d)) return <MatchDetail match={d} />;
  if (isInvestigation(d)) return <InvestigationDetail inv={d} />;
  // The approval-workflow node carries the full graph + per-step status — render
  // the SAME graph the onboarding screen draws, coloured by this run's path.
  if (isWorkflowRun(d)) return <WorkflowRunDetail data={d} />;
  if (isApprovalSummary(d)) return <ApprovalDetail approval={d} />;
  if (isRecon(d)) return <ReconDetail recon={d} />;
  return null;
}

/** The approval workflow's execution summary, as the step emits it onto the trace. */
type ApprovalSummary = {
  outcome: "posted" | "awaiting" | "rejected" | "blocked";
  steps: { id: string; status: string; detail: string }[];
};

/** The live approval-workflow node: the graph structure + this run's step statuses. */
type WorkflowRunData = {
  workflow: ApprovalWorkflow;
  steps: { id: string; status: string; detail: string }[];
  outcome: string;
};

function WorkflowRunDetail({ data }: { data: WorkflowRunData }) {
  const statuses: Record<string, string> = {};
  for (const s of data.steps) statuses[s.id] = s.status;
  return (
    <div className="-mx-1">
      <WorkflowGraph workflow={data.workflow} statuses={statuses} />
    </div>
  );
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

/** Per-step status → badge tone for the approval gates. */
function stepTone(status: string): "ok" | "warn" | "danger" | "neutral" {
  if (status === "approved" || status === "done") return "ok";
  if (status === "pending") return "warn";
  if (status === "rejected" || status === "blocked") return "danger";
  return "neutral"; // skipped / other
}

function ApprovalDetail({ approval }: { approval: ApprovalSummary }) {
  const outcomeTone =
    approval.outcome === "posted"
      ? "ok"
      : approval.outcome === "awaiting"
        ? "warn"
        : "danger";
  // Only the steps that actually mattered — hide the ones that skipped (their
  // condition wasn't met for this invoice), so the trace shows the path taken.
  const shown = approval.steps.filter((s) => s.status !== "skipped");
  return (
    <div className="space-y-1.5">
      <Row label="Outcome">
        <Badge tone={outcomeTone}>{humanize(approval.outcome)}</Badge>
      </Row>
      {shown.length > 0 && (
        <div className="space-y-1">
          {shown.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <Badge tone={stepTone(s.status)}>{humanize(s.status)}</Badge>
              <span className="text-[11px] text-muted">{s.detail}</span>
            </div>
          ))}
        </div>
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
