import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { RoutineItem } from "@rakazo/core";
import { failureSinceLabel } from "@rakazo/core";
import { CircleX } from "lucide-react";
import { useRoutineCopy } from "../bot-page/routine-copy";

export function RoutineFailureLine({
  item,
  count: failures,
  since: firstAt,
  onOpen,
}: {
  item: RoutineItem;
  count: number;
  since: string;
  onOpen: () => void;
}) {
  const { i18n, t } = useLingui();
  const copy = useRoutineCopy();
  const reason = copy.failureReason(item.finished?.failure ?? null);
  const since = failures > 1 ? failureSinceLabel(firstAt, item.ts, i18n.locale || "en") : "";
  const count =
    failures > 1
      ? plural(failures, {
          one: `# failure since ${since}`,
          other: `# failures since ${since}`,
        })
      : null;
  return (
    <button
      type="button"
      data-testid="routine-run-line"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="-mx-2 flex min-h-11 w-full items-center gap-2.5 rounded-row px-2 text-start duration-(--duration-hover) ease-quiet hover:bg-accent"
    >
      <CircleX
        className="size-4.5 shrink-0 text-destructive [&>path]:stroke-background"
        fill="currentColor"
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-row-name font-medium text-foreground" dir="auto">
        {item.name}
        {reason ? (
          <span className="font-normal text-muted-foreground"> · {reason}</span>
        ) : (
          <span className="sr-only">, {t`Failed`}</span>
        )}
      </span>
      {count ? (
        <span className="shrink-0 text-time tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </button>
  );
}
