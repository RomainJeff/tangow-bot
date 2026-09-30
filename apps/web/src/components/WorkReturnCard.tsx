import type { WorkReturn } from "../lib/work-return";

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
  return (
    <div className="flex justify-start">
      <div
        className="flex flex-col gap-2 rounded-block bg-muted px-5 py-4"
        data-testid="work-return-card"
      >
        <div className="flex items-baseline gap-2.5 text-working" data-testid="work-return-outcome">
          {workReturn.outcome === "result" ? <span className="text-success">✓</span> : null}
          {workReturn.outcome === "failed" ? <span className="text-destructive">✕</span> : null}
          <span className="font-semibold text-foreground">{specialistName}</span>
        </div>
      </div>
    </div>
  );
}
