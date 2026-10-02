import type { WorkReturn } from "../lib/work-return";
import { TaskTreeDisclosure } from "./work-tree/context";
import { outcomeMark } from "./work-tree/outcome-mark";

/**
 * The specialist's work_return card: who produced the result and how the run
 * ended, replacing the generic card renderer whose green check presented a
 * failed specialist as a success. The block `text` that follows is rendered
 * by the transcript as usual.
 */
export function WorkReturnCard({
  workReturn,
  specialistName,
  cardKey,
}: {
  workReturn: WorkReturn;
  specialistName: string;
  /** Names this card for the task tree it can unfold; without one the card has no link. */
  cardKey?: string;
}) {
  const mark = outcomeMark(workReturn.outcome);
  return (
    <div className="flex flex-col items-start">
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
      {cardKey ? <TaskTreeDisclosure cardKey={cardKey} /> : null}
    </div>
  );
}
