import { SlackIcon, NetSuiteIcon, JiraIcon } from "@/components/ui/brand-icon";
import type { StepChange } from "@/lib/approval-workflow";

export type StepStatuses = Record<string, string>;

/** Target statuses that mean "the invoice reached this node", so the edge into it is
    on the realized path (skipped/blocked are dead branches, not part of the flow). */
export const REACHED = new Set(["pending", "approved", "done", "rejected"]);

/* ── node visuals ──────────────────────────────────────────────────────────── */

export const statusTone = (
  status: string | undefined,
): { tone: "ok" | "warn" | "danger" | "neutral"; label: string } | null => {
  switch (status) {
    case "approved":
      return { tone: "ok", label: "Approved" };
    case "done":
      return { tone: "ok", label: "Done" };
    case "pending":
      return { tone: "warn", label: "In review" };
    case "rejected":
      return { tone: "danger", label: "Rejected" };
    case "blocked":
      return { tone: "danger", label: "Blocked" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    default:
      return null;
  }
};

/** The real brand mark + display name for an integration kind. */
export const integrationBrand = (
  kind: string,
): { Icon: (p: { size?: number }) => React.ReactNode; name: string } => {
  switch (kind) {
    case "slack":
      return { Icon: SlackIcon, name: "Slack" };
    case "netsuite":
      return { Icon: NetSuiteIcon, name: "NetSuite" };
    case "jira":
      return { Icon: JiraIcon, name: "Jira" };
    default:
      return { Icon: () => <span className="text-faint">→</span>, name: kind };
  }
};

export const changeRing = (change: StepChange["kind"] | undefined): string => {
  switch (change) {
    case "added":
      return "ring-ok-line bg-ok-soft/30";
    case "changed":
      return "ring-warn-line bg-warn-soft/30";
    case "removed":
      return "ring-danger-line bg-danger-soft/30";
    default:
      return "ring-line";
  }
};

export const changeBadge = (
  change: StepChange["kind"] | undefined,
): { tone: "ok" | "warn" | "danger"; label: string } | null => {
  if (change === "added") return { tone: "ok", label: "Added" };
  if (change === "changed") return { tone: "warn", label: "Changed" };
  if (change === "removed") return { tone: "danger", label: "Removed" };
  return null;
};

/** Ring/bg for a validation issue on a node (only used when there's no diff change). */
export const issueRing = (sev: "error" | "warning" | undefined): string => {
  if (sev === "error") return "ring-danger-line bg-danger-soft/20";
  if (sev === "warning") return "ring-warn-line bg-warn-soft/20";
  return "ring-line";
};

/** The label + tone for the AI investigator's verdict. */
export const VERDICT_META: Record<
  "likely_legitimate" | "likely_overcharge" | "unclear",
  { label: string; text: string; dot: string }
> = {
  likely_legitimate: {
    label: "Likely legitimate",
    text: "text-ok",
    dot: "bg-ok",
  },
  likely_overcharge: {
    label: "Likely overcharge",
    text: "text-danger",
    dot: "bg-danger",
  },
  unclear: { label: "Unclear", text: "text-warn", dot: "bg-warn" },
};
