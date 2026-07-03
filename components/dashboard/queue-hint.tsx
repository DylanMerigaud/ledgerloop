import { Badge } from "@/components/ui/badge";
import { scenarioBadge, scenarioKind } from "@/lib/display";

/**
 * The pre-run hint on a queue row: a "Start here" chip on the showcase invoice,
 * and a coloured badge ONLY for exception/blocked scenarios (clean rows stay
 * unmarked, so the marks draw the eye to the cases worth running). Renders nothing
 * for an unmarked clean row.
 */
export const QueueHint = ({
  scenario,
  startHere,
}: {
  scenario: string | null;
  startHere: boolean;
}) => {
  const badge = scenarioBadge(scenarioKind(scenario));
  if (!startHere && !badge) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {startHere && (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent ring-1 ring-inset ring-accent/20">
          <span aria-hidden>⚡</span> Start here
        </span>
      )}
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
    </span>
  );
};
