import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import type { RoutineGroupRun } from "@rakazo/core";
import { threadTimeMarkerLabel } from "@rakazo/core";
import type { StackedAvatarItem } from "@rakazo/ui-web";
import {
  Button,
  ClippedPreview,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Shimmer,
} from "@rakazo/ui-web";
import {
  Bell,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  StopCircle,
  X,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";

type RoutineRunBlock = Extract<MessageBlock, { kind: "routine_run" }>;

/** The bot a run then messaged, drawn by the run: a receipt at rest, the
 * centred `CollaborationMarker` when the line is open. */
export interface RoutineHandoff {
  /** The receiving bot's own 14 px avatar, shown as the receipt while collapsed. */
  receipt: ReactNode;
  /** Both bots, sender first, for the centred marker while the line is open. */
  bots: StackedAvatarItem[];
  label: string;
  onClick: () => void;
}

/** Past this many runs, a group opens in a dialog instead of listing in place (A8c). */
export const GROUP_DIALOG_MAX = 8;

/** The run's state as one icon: the shape tells it apart without colour, the
 * colour only confirms. Completed and failed are filled; the rest are not. */
const ROUTINE_STATE_ICON: Record<
  RoutineRunBlock["state"],
  ComponentType<{ className?: string }>
> = {
  queued: Clock,
  running: CircleDashed,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: StopCircle,
};

/** The symbol carries the colour; the word is muted unless the run failed. */
function stateColorClass(state: RoutineRunBlock["state"]): string {
  if (state === "completed") return "text-success";
  if (state === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function stateWordClass(state: RoutineRunBlock["state"]): string {
  return state === "failed" ? "text-destructive" : "text-muted-foreground";
}

/** A headline that only restates the routine's name adds nothing under it. */
function headlineRepeatsName(headline: string, name: string): boolean {
  const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const short = letters(headline);
  return short.length > 0 && letters(name).includes(short);
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

export function sameLocalDay(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  return new Date(left).toDateString() === new Date(right).toDateString();
}

/** Digest content, worth opening: the full digest, or a headline that says
 * more than the routine's own name. */
function digestOf(block: RoutineRunBlock): string | undefined {
  const digest = block.digest?.trim();
  if (digest) return digest;
  if (block.headline && !headlineRepeatsName(block.headline, block.routineName)) {
    return block.headline;
  }
  return undefined;
}

/**
 * A routine run as a log line, not a card: status icon, name, time, status
 * word, then fixed receipt/bell/disclosure slots so the columns line up down
 * a run of routines. Opening it shows the report under an `outline` rail and,
 * centred like every exchange between bots, the message it then sent. A
 * failed run and a subscribed one open on their report (only for the
 * routine's latest run).
 */
export function RoutineRunLine({
  item,
  handoff,
  nested = false,
  withDay = false,
}: {
  item: RoutineGroupRun;
  handoff?: RoutineHandoff;
  /** A line inside an open group: smaller icon, the time in the name slot. */
  nested?: boolean;
  withDay?: boolean;
}) {
  const { t } = useLingui();
  const block = item.run;
  const digest = digestOf(block);
  const subscribed = Boolean(block.notify);
  const failed = block.state === "failed";
  const opens = Boolean(digest || handoff);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  // Only a routine's latest run opens on its own (failed, or subscribed):
  // older ones stay folded so a thread of past failures is not a wall of reports.
  const expanded =
    opens && (manualExpanded ?? Boolean(digest && item.latest && (subscribed || failed)));
  const locale = i18n.locale || "en";
  const time = routineTime(item.createdAt, locale, withDay);
  const statusLabel =
    block.state === "queued"
      ? t`Queued`
      : block.state === "running"
        ? t`Running`
        : block.state === "completed"
          ? t`Completed`
          : failed
            ? t`Failed`
            : t`Cancelled`;
  const Icon = ROUTINE_STATE_ICON[block.state];
  const colorClass = stateColorClass(block.state);
  const wordClass = stateWordClass(block.state);
  const filled = block.state === "completed" || block.state === "failed";
  const accessibleLabel = [
    block.routineName,
    statusLabel,
    time,
    subscribed ? t`Notifications on` : null,
    handoff?.label,
  ]
    .filter(Boolean)
    .join(", ");

  const row = (
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
        {nested && time ? time : block.routineName}
      </span>
      {time && !nested ? (
        <span className="shrink-0 text-time tabular-nums text-muted-foreground">{time}</span>
      ) : null}
      {block.state === "running" ? (
        <Shimmer className={`shrink-0 text-label font-medium ${wordClass}`}>{statusLabel}</Shimmer>
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
        {opens ? <RoutineDisclosure expanded={expanded} /> : null}
      </span>
    </div>
  );

  return (
    <div data-testid="routine-run-line">
      {opens ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={accessibleLabel}
          onClick={() => setManualExpanded(!expanded)}
          className="block w-full text-start duration-(--duration-hover) ease-quiet hover:bg-accent"
        >
          {row}
        </button>
      ) : (
        <>
          <span className="sr-only">{accessibleLabel}</span>
          <div aria-hidden="true">{row}</div>
        </>
      )}
      {expanded ? (
        <div className="mb-2 ms-2.75 ps-4.5 pt-2 border-s border-outline">
          {digest ? (
            <ClippedPreview
              text={digest}
              maxLines={8}
              fadeFrom="from-background"
              onOpen={() => setReportOpen(true)}
              ariaLabel={t`Report, ${block.routineName} · Opens in full`}
            >
              <div dir="auto">
                <ChatMarkdown allowImages={false}>{truncateMarkdownForRender(digest)}</ChatMarkdown>
              </div>
            </ClippedPreview>
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
      {reportOpen && digest ? (
        <Dialog open onOpenChange={setReportOpen}>
          <DialogContent
            showCloseButton={false}
            className="max-h-[85vh] w-[min(640px,94vw)] overflow-y-auto sm:max-w-none"
          >
            <div className="flex items-center justify-between">
              <DialogTitle>{block.routineName}</DialogTitle>
              <DialogClose
                aria-label={t`Close report`}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <X />
              </DialogClose>
            </div>
            <div dir="auto">
              <ChatMarkdown allowImages={false}>{digest}</ChatMarkdown>
            </div>
            {handoff ? (
              <div className="flex justify-center border-t border-border pt-3">
                <CollaborationMarker
                  ariaLabel={handoff.label}
                  bots={handoff.bots}
                  label={handoff.label}
                  onClick={() => {
                    setReportOpen(false);
                    handoff.onClick();
                  }}
                />
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
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
}: {
  runs: RoutineGroupRun[];
  handoffFor: (run: RoutineGroupRun) => RoutineHandoff | undefined;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const locale = i18n.locale || "en";
  const first = runs[0]!;
  const last = runs.at(-1)!;
  const spansDays = !sameLocalDay(first.createdAt, last.createdAt);
  const range = routineRange(first.createdAt, last.createdAt, locale);
  const cancelledCount = runs.filter((item) => item.run.state === "cancelled").length;
  const statusLabel = cancelledCount ? t`${cancelledCount} cancelled` : t`Completed`;
  // Only completed and cancelled runs fold, so any cancelled one makes the
  // group read as cancelled, drawn like a single cancelled run.
  const groupState = cancelledCount ? "cancelled" : "completed";
  const GroupIcon = ROUTINE_STATE_ICON[groupState];
  const runsCount = runs.length;
  const countLabel = t`${runsCount} runs`;
  const handoffs = runs.map(handoffFor);
  const receiptBotIds = new Set(runs.map((item) => item.sentTo?.toBotId).filter(Boolean));
  const receipt = receiptBotIds.size === 1 ? handoffs.find(Boolean)?.receipt : null;
  const inDialog = runs.length > GROUP_DIALOG_MAX;
  const accessibleLabel = [first.run.routineName, countLabel, range, statusLabel].join(", ");

  const lines = (
    <div className="ms-7">
      {runs.map((item, index) => (
        <RoutineRunLine
          key={item.messageId}
          item={item}
          handoff={handoffs[index]}
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
          {first.run.routineName} <span className="text-muted-foreground">{countLabel}</span>
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
            <DialogTitle>{first.run.routineName}</DialogTitle>
            <div className="pt-1">
              {runs.map((item, index) => {
                const dayStarts =
                  index === 0 || !sameLocalDay(runs[index - 1]!.createdAt, item.createdAt);
                return (
                  <div key={item.messageId}>
                    {dayStarts && item.createdAt ? (
                      <p className="mb-1 mt-4 text-label font-medium text-muted-foreground first:mt-2">
                        {threadTimeMarkerLabel(item.createdAt, {
                          locale,
                          today: t`Today`,
                          yesterday: t`Yesterday`,
                          withTime: false,
                        })}
                      </p>
                    ) : null}
                    <RoutineRunLine item={item} handoff={handoffs[index]} nested />
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
