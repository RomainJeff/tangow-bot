import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/web";
import type { RunActivityRow, RunStatus } from "@rakazo/contracts";
import type { ActivityItem, RecapBody, RecapRead } from "@rakazo/core";
import {
  dayMarkers,
  foldActivity,
  recapView,
  reduceActivity,
  threadTimeMarkerLabel,
} from "@rakazo/core";
import { Button, ClippedPreview, Shimmer, Skeleton } from "@rakazo/ui-web";
import {
  CalendarPlus,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Sparkles,
  StopCircle,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { rpc } from "../../lib/rpc";
import type { BotCommands } from "../shell/bot-commands";
import { useRoutineCopy } from "./routine-copy";

/**
 * A bot's activity, newest first, a page at a time. Reads again when a run ends (`epoch`) and
 * when the window comes back into focus.
 */
function useBotActivity(botId: string, epoch: number) {
  const [read, dispatch] = useReducer(reduceActivity, { kind: "loading" });
  const readRef = useRef(read);
  readRef.current = read;
  // Each first-page read bumps the token, so an older answer, or an earlier page asked for before it, is dropped.
  const token = useRef(0);

  const load = useCallback(async () => {
    const mine = ++token.current;
    try {
      const page = await rpc.bots.activity({ botId });
      if (mine === token.current) dispatch({ type: "first", page });
    } catch {
      if (mine === token.current) dispatch({ type: "first-failed" });
    }
  }, [botId]);

  const showEarlier = useCallback(async () => {
    const current = readRef.current;
    if (current.kind !== "ready" || !current.next || current.earlier === "loading") return;
    const mine = token.current;
    const cursor = current.next;
    dispatch({ type: "earlier-started" });
    try {
      const page = await rpc.bots.activity({ botId, cursor });
      if (mine === token.current) dispatch({ type: "earlier", page });
    } catch {
      if (mine === token.current) dispatch({ type: "earlier-failed" });
    }
  }, [botId]);

  const retry = useCallback(() => {
    dispatch({ type: "retry" });
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, epoch]);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  return { read, showEarlier, retry };
}

/** What a run left in its thread, read when its line opens and again once its status moves. */
function useRunRecap(runId: string, status: RunStatus, open: boolean) {
  const [read, setRead] = useState<RecapRead | null>(null);
  // A new status makes what was read stale.
  useEffect(() => setRead(null), [status]);
  const load = useCallback(() => {
    setRead({ kind: "loading" });
    rpc.runs.recap({ runId }).then(
      (recap) => setRead({ kind: "ready", recap }),
      () => setRead({ kind: "failed" }),
    );
  }, [runId]);
  useEffect(() => {
    if (open && read === null) load();
  }, [open, read, load]);
  return { read, retry: load };
}

/**
 * Which run lines are open, kept by the list: a run that ends moves from the top to its day and
 * is drawn anew there, and must stay open.
 */
const OpenRuns = createContext<{ open: ReadonlySet<string>; toggle: (runId: string) => void }>({
  open: new Set(),
  toggle: () => {},
});

function useOpenRuns() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((runId: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  }, []);
  return useMemo(() => ({ open, toggle }), [open, toggle]);
}

type StateWord = "done" | "failed" | "cancelled" | "running" | "waiting";

/** Each run status as a symbol, a colour that only confirms it, and one word. */
const RUN_STATE: Record<
  RunStatus,
  { word: StateWord; Icon: ComponentType<{ className?: string }>; tone: string; filled: boolean }
> = {
  queued: { word: "waiting", Icon: Clock, tone: "text-muted-foreground", filled: false },
  leased: { word: "running", Icon: CircleDashed, tone: "text-muted-foreground", filled: false },
  running: { word: "running", Icon: CircleDashed, tone: "text-muted-foreground", filled: false },
  waiting_input: { word: "waiting", Icon: Clock, tone: "text-muted-foreground", filled: false },
  waiting_takeover: { word: "waiting", Icon: Clock, tone: "text-muted-foreground", filled: false },
  completed: { word: "done", Icon: CircleCheck, tone: "text-success", filled: true },
  failed: { word: "failed", Icon: CircleX, tone: "text-destructive", filled: true },
  cancelled: { word: "cancelled", Icon: StopCircle, tone: "text-muted-foreground", filled: false },
};

function runTime(row: RunActivityRow): string {
  return RUN_STATE[row.status].word === "running" || RUN_STATE[row.status].word === "waiting"
    ? (row.startedAt ?? row.updatedAt)
    : (row.completedAt ?? row.updatedAt);
}

function itemKey(item: ActivityItem): string {
  switch (item.kind) {
    case "run":
      return item.row.runId;
    case "folded":
      return `folded-${item.runs[0]?.runId}`;
    case "routine_created":
      return `routine-${item.routineId}`;
    case "bot_created":
      return `bot-${item.botId}`;
  }
}

type OpenRun = BotCommands["openRun"];

/**
 * The bot's routine runs, the routines it was given and its own creation, grouped by day. A run
 * opens its recap in place, with a way into the chat; a routine's creation opens the routine.
 * With `onWriteInstructions` (a bot with no instructions yet) its creation offers to write them.
 */
export function BotActivity({
  botId,
  commands,
  onOpenRoutine,
  onWriteInstructions,
}: {
  botId: string;
  commands: Pick<BotCommands, "activityEpoch" | "openRun">;
  onOpenRoutine: (routineId: string) => void;
  onWriteInstructions?: () => void;
}) {
  const { openRun } = commands;
  const { t, i18n } = useLingui();
  const { read, showEarlier, retry } = useBotActivity(botId, commands.activityEpoch);
  const openRuns = useOpenRuns();
  const locale = i18n.locale || "en";

  if (read.kind === "loading") return <LoadingRows />;
  if (read.kind === "failed") {
    return <CouldNotLoad onRetry={retry} className="py-10 text-center text-meta" />;
  }
  if (read.entries.length === 0) {
    return (
      <p className="py-10 text-center text-meta text-muted-foreground">{t`No activity yet`}</p>
    );
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = dayMarkers(foldActivity(read.entries), timeZone);
  return (
    <OpenRuns.Provider value={openRuns}>
      <div data-testid="bot-activity" className="flex flex-col">
        {days.map(({ day, at, items }) => (
          <section key={day ?? "now"} className="flex flex-col not-first:pt-3">
            {day ? (
              <h3 className="pb-1.5 ps-0.5 text-label text-muted-foreground">
                {threadTimeMarkerLabel(at, {
                  locale,
                  today: t`Today`,
                  yesterday: t`Yesterday`,
                  withTime: false,
                })}
              </h3>
            ) : null}
            {items.map((item) => (
              <ActivityLine
                key={itemKey(item)}
                item={item}
                openRun={openRun}
                onOpenRoutine={onOpenRoutine}
                onWriteInstructions={onWriteInstructions}
              />
            ))}
          </section>
        ))}
        {read.next ? (
          <Button
            variant="tertiary"
            size="capsule"
            className="-ms-3 mt-2 self-start"
            disabled={read.earlier === "loading"}
            onClick={() => void showEarlier()}
          >
            {read.earlier === "failed" ? t`Could not load · Retry` : t`Show earlier`}
          </Button>
        ) : null}
      </div>
    </OpenRuns.Provider>
  );
}

function ActivityLine({
  item,
  openRun,
  onOpenRoutine,
  onWriteInstructions,
}: {
  item: ActivityItem;
  openRun: OpenRun;
  onOpenRoutine: (routineId: string) => void;
  onWriteInstructions?: () => void;
}) {
  const { t } = useLingui();
  switch (item.kind) {
    case "run":
      return <RunLine row={item.row} openRun={openRun} />;
    case "folded":
      return <FoldedLine name={item.name} runs={item.runs} openRun={openRun} />;
    case "routine_created": {
      const by = item.byBotName;
      return (
        <CreationLine
          Icon={CalendarPlus}
          name={item.routineName}
          detail={by ? t`Routine created by ${by}` : t`Routine created`}
          at={item.createdAt}
          onOpen={() => onOpenRoutine(item.routineId)}
        />
      );
    }
    case "bot_created": {
      const name = item.botName;
      return (
        <CreationLine Icon={Sparkles} name={t`${name} created`} at={item.createdAt}>
          {onWriteInstructions ? (
            <Button
              variant="link"
              data-opens="instructions"
              className="h-auto self-start rounded-chip border-0 p-0 text-meta font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={onWriteInstructions}
            >
              {t`Write its first instructions`}
            </Button>
          ) : null}
        </CreationLine>
      );
    }
  }
}

function useRunWords() {
  const { t, i18n } = useLingui();
  const copy = useRoutineCopy();
  const locale = i18n.locale || "en";
  const words: Record<StateWord, string> = {
    done: t`Done`,
    failed: t`Failed`,
    cancelled: t`Cancelled`,
    running: t`Running`,
    waiting: t`Waiting`,
  };
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return { words, time, reason: copy.failureReason, routine: t`Routine` };
}

/** A filled symbol draws its mark in the surface colour so it stays readable on the fill. */
const FILLED = "[&>path]:stroke-surface";

const STATIC_LINE = "flex min-h-11 w-full items-center gap-2.5 rounded-row px-2 -mx-2 text-start";
const LINE = `${STATIC_LINE} outline-none duration-(--duration-hover) ease-quiet hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50`;

function Disclosure({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden
      className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-hover) ease-quiet motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    />
  );
}

function RunLine({ row, openRun }: { row: RunActivityRow; openRun: OpenRun }) {
  const run = useRunWords();
  const runs = useContext(OpenRuns);
  const open = runs.open.has(row.runId);
  const recap = useRunRecap(row.runId, row.status, open);
  const view = recapView(recap.read, {
    failed: row.status === "failed",
    sourceMessageId: row.sourceMessageId,
  });
  const state = RUN_STATE[row.status];
  const name = row.routineName ?? run.routine;
  const word = run.words[state.word];
  const reason = row.status === "failed" ? run.reason(row.failureKind) : null;
  const time = run.time(runTime(row));
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={[name, reason, word, time].filter(Boolean).join(", ")}
        onClick={() => runs.toggle(row.runId)}
        data-testid="activity-run"
        className={LINE}
      >
        <state.Icon
          className={`size-4.5 shrink-0 ${state.tone} ${state.filled ? FILLED : ""}`}
          {...(state.filled ? { fill: "currentColor" } : {})}
          aria-hidden
        />
        <span
          className="min-w-0 flex-1 truncate text-row-name font-medium text-foreground"
          dir="auto"
        >
          {name}
          {reason ? <span className="font-normal text-muted-foreground"> · {reason}</span> : null}
        </span>
        <span className="shrink-0 text-time tabular-nums text-muted-foreground">{time}</span>
        {state.word === "running" ? (
          <Shimmer className="shrink-0 text-label font-medium text-muted-foreground">
            {word}
          </Shimmer>
        ) : (
          <span
            className={`shrink-0 text-label font-medium ${
              state.word === "failed" ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {word}
          </span>
        )}
        <Disclosure open={open} />
      </button>
      {open ? (
        <RunRecapBody
          body={view.body}
          onRetry={recap.retry}
          onOpenChat={() =>
            openRun({ botId: row.botId, groupId: row.groupId, sourceMessageId: view.jumpTo })
          }
        />
      ) : null}
    </div>
  );
}

/** A run's recap under an `outline` rail: what it wrote, then the way into the chat. */
function RunRecapBody({
  body,
  onRetry,
  onOpenChat,
}: {
  body: RecapBody;
  onRetry: () => void;
  onOpenChat: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-testid="activity-recap"
      className="mb-2 ms-2.75 flex flex-col items-start gap-1 border-s border-outline pt-1 ps-4.5"
    >
      {body.kind === "loading" ? (
        <div aria-busy className="flex w-full flex-col gap-2 py-1">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      ) : body.kind === "failed" ? (
        <CouldNotLoad onRetry={onRetry} className="text-meta" />
      ) : body.kind === "text" ? (
        <RecapText text={body.text} />
      ) : body.kind === "no_report" ? (
        <p className="text-meta text-muted-foreground">{t`No report`}</p>
      ) : null}
      <Button variant="tertiary" size="capsule" className="-ms-3" onClick={onOpenChat}>
        {t`Open in chat`}
      </Button>
    </div>
  );
}

/**
 * A recap in the chat's own markdown, without remote images, cut to eight lines when it hides at
 * least three more; pressing the preview shows the rest in place.
 */
function RecapText({ text }: { text: string }) {
  const { t } = useLingui();
  const [more, setMore] = useState(false);
  const markdown = (
    <div dir="auto">
      <ChatMarkdown allowImages={false}>{truncateMarkdownForRender(text)}</ChatMarkdown>
    </div>
  );
  return more ? (
    <div className="w-full">{markdown}</div>
  ) : (
    <div className="w-full">
      <ClippedPreview
        text={text}
        maxLines={8}
        fadeFrom="from-surface"
        onOpen={() => setMore(true)}
        ariaLabel={t`Show more`}
      >
        {markdown}
      </ClippedPreview>
    </div>
  );
}

/** "Could not load · Retry", in place of what failed to read. */
function CouldNotLoad({ onRetry, className }: { onRetry: () => void; className: string }) {
  const { t } = useLingui();
  return (
    <p className={`text-muted-foreground ${className}`}>
      {t`Could not load`}
      {" · "}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-chip underline underline-offset-2 outline-none duration-(--duration-hover) ease-quiet hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {t`Retry`}
      </button>
    </p>
  );
}

/** Rows that keep the height of what is loading; never a bare spinner. */
function LoadingRows() {
  return (
    <div aria-busy className="flex flex-col">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex min-h-11 items-center gap-2.5">
          <Skeleton className="size-4.5 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

function CreationLine({
  Icon,
  name,
  detail,
  at,
  onOpen,
  children,
}: {
  Icon: ComponentType<{ className?: string }>;
  name: string;
  detail?: string;
  at: string;
  onOpen?: () => void;
  /** A sub-line under the name, on a line that does not open anything itself. */
  children?: ReactNode;
}) {
  const run = useRunWords();
  const time = run.time(at);
  const Line = onOpen ? "button" : "div";
  return (
    <Line
      {...(onOpen
        ? {
            type: "button" as const,
            onClick: onOpen,
            "aria-label": [name, detail, time].filter(Boolean).join(", "),
          }
        : {})}
      data-testid="activity-created"
      className={onOpen ? LINE : STATIC_LINE}
    >
      <Icon className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
      {/* Wraps rather than cut: who made the routine is the end of the line. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5">
        <span className="text-row-name font-medium text-foreground" dir="auto">
          {name}
          {detail ? <span className="font-normal text-muted-foreground"> · {detail}</span> : null}
        </span>
        {children}
      </span>
      <span className="shrink-0 text-time tabular-nums text-muted-foreground">{time}</span>
      <span className="w-3.5 shrink-0" />
    </Line>
  );
}

function FoldedLine({
  name,
  runs,
  openRun,
}: {
  name: string | null;
  runs: RunActivityRow[];
  openRun: OpenRun;
}) {
  const run = useRunWords();
  const [open, setOpen] = useState(false);
  const title = name ?? run.routine;
  const count = plural(runs.length, { one: "# run", other: "# runs" });
  const newest = runs[0];
  const time = newest ? run.time(runTime(newest)) : "";
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={[title, count, run.words.done, time].join(", ")}
        onClick={() => setOpen(!open)}
        className={LINE}
      >
        <CircleCheck
          className={`size-4.5 shrink-0 text-success ${FILLED}`}
          fill="currentColor"
          aria-hidden
        />
        <span
          className="min-w-0 flex-1 truncate text-row-name font-medium text-foreground"
          dir="auto"
        >
          {title} <span className="font-normal text-muted-foreground">· {count}</span>
        </span>
        <span className="shrink-0 text-time tabular-nums text-muted-foreground">{time}</span>
        <span className="shrink-0 text-label font-medium text-muted-foreground">
          {run.words.done}
        </span>
        <Disclosure open={open} />
      </button>
      {open ? (
        <div className="ms-7">
          {runs.map((row) => (
            <RunLine key={row.runId} row={row} openRun={openRun} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
