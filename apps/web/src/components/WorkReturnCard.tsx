import { t } from "@lingui/core/macro";
import type { WorkReturn } from "../lib/work-return";

function outcomeMark(outcome: WorkReturn["outcome"]) {
  if (outcome === "result") return { glyph: "✓", tone: "text-success", label: t`Done` };
  if (outcome === "failed") return { glyph: "✕", tone: "text-destructive", label: t`Failed` };
  if (outcome === "cancelled")
    return { glyph: "⊘", tone: "text-muted-foreground", label: t`Cancelled` };
  if (outcome === "no_result")
    return { glyph: "–", tone: "text-muted-foreground", label: t`No result` };
  return null;
}

/**
 * The specialist's work_return card: who produced the result and how the run
 * ended, replacing the generic card renderer whose green check presented a
 * failed specialist as a success. The block `text` that follows is rendered
 * by the transcript as usual.
 */
export function WorkReturnCard({
  workReturn,
  specialistName,
}: {
  workReturn: WorkReturn;
  specialistName: string;
}) {
  const mark = outcomeMark(workReturn.outcome);
  return (
    <div className="flex justify-start">
      <div
        className="flex flex-col gap-2 rounded-block bg-muted px-5 py-4"
        data-testid="work-return-card"
      >
        <div className="flex items-baseline gap-2.5 text-working" data-testid="work-return-outcome">
          {mark ? (
            <span className={mark.tone} aria-hidden>
              {mark.glyph}
            </span>
          ) : null}
          <span className="font-semibold text-foreground">{specialistName}</span>
          {mark ? <span className="text-muted-foreground">{mark.label}</span> : null}
        </div>
      </div>
    </div>
  );
}
