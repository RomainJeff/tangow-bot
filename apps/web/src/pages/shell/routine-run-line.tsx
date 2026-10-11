import { i18n } from "@lingui/core";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/web";
import type { RoutineLineRun } from "@rakazo/core";
import { threadTimeMarkerLabel } from "@rakazo/core";
import type { StackedAvatarItem } from "@rakazo/ui-web";
import { ClippedPreview, Dialog, DialogContent, DialogTitle, Shimmer } from "@rakazo/ui-web";
import {
  Bell,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  StopCircle,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";

type RoutineState = "queued" | "running" | "completed" | "failed" | "cancelled";

/** The bot a run then messaged, drawn by the run: a receipt at rest, the
 * centred `CollaborationMarker` when the line is open. */
export interface RoutineHandoff {
  /** The receiving bot's own 14 px avatar, shown as the receipt while collapsed. */
  receipt: ReactNode;
  /** Both bots, sender first, for the centred marker while the line is open. */
  bots: StackedAvatarItem[];
  label: string;
  onClick?: () => void;
}

/** Past this many runs, a group opens in a dialog instead of listing in place (A8c). */
const GROUP_DIALOG_MAX = 8;

/** The run's state as one icon: the shape tells it apart without colour, the
 * colour only confirms. Completed and failed are filled; the rest are not. */
const ROUTINE_STATE_ICON: Record<RoutineState, ComponentType<{ className?: string }>> = {
  queued: Clock,
  running: CircleDashed,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: StopCircle,
};

function routineState(run: RoutineLineRun, queued = false): RoutineState {
  return run.item.finished?.status ?? (queued ? "queued" : "running");
}

/** The symbol carries the colour; the word is muted unless the run failed. */
function stateColorClass(state: RoutineState): string {
  if (state === "completed") return "text-success";
  if (state === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function stateWordClass(state: RoutineState): string {
  return state === "failed" ? "text-destructive" : "text-muted-foreground";
}

function routineTime(createdAt: string | undefined, locale: string, withDay: boolean): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return withDay ? `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}` : time;
}

/** A group's span: its hours on one day, its days across several ("Mon – Wed", "Sep 22 – 28"). */
function routineRange(first: string | undefined, last: string | undefined, locale: string): string {
  if (!first || !last) return "";
  if (sameLocalDay(first, last))
    return `${routineTime(first, locale, false)} – ${routineTime(last, locale, false)}`;
  const start = new Date(first);
  const end = new Date(last);
  const overAWeek = end.getTime() - start.getTime() > 6 * 86_400_000;
  const day = (date: Date) =>
    overAWeek
      ? date.toLocaleDateString(locale, { month: "short", day: "numeric" })
      : date.toLocaleDateString(locale, { weekday: "short" });
  return `${day(start)} – ${day(end)}`;
}

function sameLocalDay(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  return new Date(left).toDateString() === new Date(right).toDateString();
}

export function RoutineRunLine({
  run,
  handoff,
  onOpen,
  queued = false,
  nested = false,
  withDay = false,
}: {
  run: RoutineLineRun;
  handoff?: RoutineHandoff;
  onOpen: () => void;
  /** Its run waits in the queue, not started yet. */
  queued?: boolean;
  /** A line inside an open group: smaller icon, the time in the name slot. */
  nested?: boolean;
  withDay?: boolean;
}) {
  const { t } = useLingui();
  const { item } = run;
  const state = routineState(run, queued);
  const digest = item.finished?.result.trim() || undefined;
  const failed = state === "failed";
  const subscribed = item.notify === true;
  const expands = Boolean(digest || handoff);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  // Only a routine's latest run opens on its own: older ones stay folded so past reports are no wall.
  const expanded =
    expands && (manualExpanded ?? Boolean(digest && run.latest && (subscribed || failed)));
  const locale = i18n.locale || "en";
  const time = routineTime(item.ts, locale, withDay);
  const statusLabel =
    state === "queued"
      ? t`Queued`
      : state === "running"
        ? t`Running`
        : state === "completed"
          ? t`Completed`
          : failed
            ? t`Failed`
            : t`Cancelled`;
  const Icon = ROUTINE_STATE_ICON[state];
  const colorClass = stateColorClass(state);
  const wordClass = stateWordClass(state);
  const filled = state === "completed" || state === "failed";
  const accessibleLabel = [
    item.name,
    statusLabel,
    time,
    subscribed ? t`Notifications on` : null,
    handoff?.label,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div data-testid="routine-run-line">
      <button
        type="button"
        aria-expanded={expands ? expanded : undefined}
        aria-haspopup={expands ? undefined : "dialog"}
        aria-label={accessibleLabel}
        onClick={() => (expands ? setManualExpanded(!expanded) : onOpen())}
        className="block w-full text-start duration-(--duration-hover) ease-quiet hover:bg-accent"
      >
        <div className="flex min-h-11 w-full items-center gap-2.5 rounded-row px-2 -mx-2">
          <Icon
            className={`size-4.5 shrink-0 ${colorClass}`}
            {...(filled ? { fill: "currentColor" } : {})}
            aria-hidden="true"
          />
          <span
            className="min-w-0 flex-1 text-row-name font-medium text-foreground"
            dir={nested ? undefined : "auto"}
          >
            {nested && time ? time : item.name}
          </span>
          {time && !nested ? (
            <span className="shrink-0 text-time tabular-nums text-muted-foreground">{time}</span>
          ) : null}
          {state === "running" ? (
            <Shimmer className={`shrink-0 text-label font-medium ${wordClass}`}>
              {statusLabel}
            </Shimmer>
          ) : (
            <span className={`shrink-0 text-label font-medium ${wordClass}`}>{statusLabel}</span>
          )}
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            {handoff && !expanded ? handoff.receipt : null}
          </span>
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            {subscribed ? (
              <Bell
                role="img"
                aria-label={t`Notifications on`}
                className="size-3.5 text-muted-foreground"
              />
            ) : null}
          </span>
          <span className="flex w-3.5 shrink-0 items-center justify-center">
            <RoutineDisclosure expanded={expanded} />
          </span>
        </div>
      </button>
      {expanded ? (
        <div className="mb-2 ms-2.75 ps-4.5 pt-2 border-s border-outline">
          {digest ? (
            // The button lies over the words instead of wrapping them: the markdown can hold
            // links, which cannot nest in a button.
            <div className="group relative">
              <div inert className="duration-(--duration-hover) ease-quiet group-hover:opacity-90">
                <ClippedPreview text={digest} maxLines={8} fadeFrom="from-background">
                  <div dir="auto">
                    <ChatMarkdown allowImages={false}>
                      {truncateMarkdownForRender(digest)}
                    </ChatMarkdown>
                  </div>
                </ClippedPreview>
              </div>
              <button
                type="button"
                aria-label={t`Report, ${item.name} · Opens in full`}
                aria-haspopup="dialog"
                onClick={onOpen}
                className="absolute inset-0"
              />
            </div>
          ) : null}
          {handoff ? (
            <div className="flex justify-center py-1">
              <CollaborationMarker
                ariaLabel={handoff.label}
                bots={handoff.bots}
                label={handoff.label}
                onClick={handoff.onClick}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The `ReasoningDisclosure` idiom: `ChevronRight` turning 90° open. Reduced
 * motion (`motion-reduce:`) drops the transition and the rotation happens at
 * once instead (A10). */
function RoutineDisclosure({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={`size-3.5 text-muted-foreground transition-transform duration-(--duration-hover) ease-quiet motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
    />
  );
}

/**
 * Several consecutive quiet routine runs of a bot, with nothing between them,
 * as one line: how many, over what span, and whether any was cancelled
 * (failed and running runs are never folded — they keep their own line).
 * Opening it lists each run as a line of its own; past `GROUP_DIALOG_MAX`
 * runs it opens in a dialog instead, sectioned by day (A8c).
 */
export function RoutineGroupLine({
  runs,
  handoffFor,
  onOpenRun,
}: {
  runs: RoutineLineRun[];
  handoffFor: (run: RoutineLineRun) => RoutineHandoff | undefined;
  onOpenRun: (run: RoutineLineRun) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const locale = i18n.locale || "en";
  const first = runs[0]!;
  const last = runs.at(-1)!;
  const spansDays = !sameLocalDay(first.item.ts, last.item.ts);
  const range = routineRange(first.item.ts, last.item.ts, locale);
  const cancelledCount = runs.filter((run) => routineState(run) === "cancelled").length;
  const statusLabel = cancelledCount
    ? plural(cancelledCount, { one: "# cancelled", other: "# cancelled" })
    : t`Completed`;
  const countLabel = plural(runs.length, { one: "# run", other: "# runs" });
  // Only completed and cancelled runs fold, so any cancelled one makes the
  // group read as cancelled, drawn like a single cancelled run.
  const groupState = cancelledCount ? "cancelled" : "completed";
  const GroupIcon = ROUTINE_STATE_ICON[groupState];
  const handoffs = runs.map(handoffFor);
  const receiptPeers = new Set(runs.map((run) => run.sentTo?.peer.name).filter(Boolean));
  const receipt = receiptPeers.size === 1 ? handoffs.find(Boolean)?.receipt : null;
  const inDialog = runs.length > GROUP_DIALOG_MAX;
  const accessibleLabel = [first.item.name, countLabel, range, statusLabel].join(", ");

  const lines = (
    <div className="ms-7">
      {runs.map((run, index) => (
        <RoutineRunLine
          key={run.item.id}
          run={run}
          handoff={handoffs[index]}
          onOpen={() => onOpenRun(run)}
          nested
          withDay={spansDays}
        />
      ))}
    </div>
  );

  return (
    <div data-testid="routine-group-line">
      <button
        type="button"
        aria-expanded={inDialog ? undefined : open}
        aria-haspopup={inDialog ? "dialog" : undefined}
        aria-label={accessibleLabel}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-row px-2 -mx-2 text-start duration-(--duration-hover) ease-quiet hover:bg-accent"
      >
        <GroupIcon
          className={`size-4.5 shrink-0 ${stateColorClass(groupState)}`}
          {...(groupState === "completed" ? { fill: "currentColor" } : {})}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 text-row-name font-medium text-foreground" dir="auto">
          {first.item.name} <span className="text-muted-foreground">{countLabel}</span>
        </span>
        <span className="shrink-0 text-time tabular-nums text-muted-foreground">{range}</span>
        <span className="shrink-0 text-label font-medium text-muted-foreground">{statusLabel}</span>
        <span className="flex w-3.5 shrink-0 items-center justify-center">{receipt}</span>
        <span className="w-3.5 shrink-0" />
        <span className="flex w-3.5 shrink-0 items-center justify-center">
          <RoutineDisclosure expanded={open && !inDialog} />
        </span>
      </button>
      {open && !inDialog ? lines : null}
      {open && inDialog ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[85vh] w-[min(640px,94vw)] overflow-y-auto sm:max-w-none">
            <DialogTitle>{first.item.name}</DialogTitle>
            <div className="pt-1">
              {runs.map((run, index) => {
                const dayStarts =
                  index === 0 || !sameLocalDay(runs[index - 1]!.item.ts, run.item.ts);
                return (
                  <div key={run.item.id}>
                    {dayStarts ? (
                      <p className="mb-1 mt-4 text-label font-medium text-muted-foreground first:mt-2">
                        {threadTimeMarkerLabel(run.item.ts, {
                          locale,
                          today: t`Today`,
                          yesterday: t`Yesterday`,
                          withTime: false,
                        })}
                      </p>
                    ) : null}
                    <RoutineRunLine
                      run={run}
                      handoff={handoffs[index]}
                      onOpen={() => onOpenRun(run)}
                      nested
                    />
                  </div>
                );
              })}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
