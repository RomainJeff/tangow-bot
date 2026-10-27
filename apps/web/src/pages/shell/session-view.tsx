import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/web";
import type { SessionEntry, SessionEntryOf } from "@rakazo/contracts";
import {
  classifyRunFailure,
  drawsNothing,
  projectThreadView,
  unshownRunReport,
} from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  formatShortDuration,
} from "@rakazo/ui-web";
import { Check, Copy, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useDebugMode } from "../../lib/debug-mode";
import { hasRenderableBlock } from "../../lib/message-blocks";
import { rpc } from "../../lib/rpc";
import type { SessionViewTarget } from "../../lib/thread-items";
import type { RowContext } from "./thread-row";
import { RowMarker, rowChrome, ThreadRowBody } from "./thread-row";

type Read = { entries: SessionEntry[] | null; truncated?: true; failed: boolean };

export function SessionView({
  target,
  context,
  onClose,
}: {
  target: SessionViewTarget;
  context: Omit<RowContext, "waiting" | "onAnswer" | "onOpenSession" | "messageOfEntry">;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const showSteps = useDebugMode();
  const [current, setCurrent] = useState(target);
  const [reloadKey, setReloadKey] = useState(0);
  const [read, setRead] = useState<Read>({ entries: null, failed: false });

  useEffect(() => {
    const abort = new AbortController();
    setRead({ entries: null, failed: false });
    const load =
      current.kind === "session"
        ? rpc.sessions.entries({ sessionId: current.sessionId }, { signal: abort.signal })
        : rpc.runs.entries({ runId: current.runId }, { signal: abort.signal });
    void load.then(
      ({ entries, truncated }) => {
        if (!abort.signal.aborted) setRead({ entries, truncated, failed: false });
      },
      () => {
        if (!abort.signal.aborted) setRead({ entries: null, failed: true });
      },
    );
    return () => abort.abort();
  }, [current, reloadKey]);

  const view = useMemo(
    () =>
      read.entries
        ? projectThreadView(read.entries, {
            rendersNothing: (item) =>
              drawsNothing(item, (blocks) => hasRenderableBlock(blocks, showSteps)) ||
              (item.kind === "routine" && current.kind === "run" && item.runId === current.runId),
          })
        : null,
    [read.entries, showSteps, current],
  );
  const report =
    read.entries && current.kind === "run"
      ? unshownRunReport(read.entries, current.runId)
      : undefined;
  const rowContext = useMemo<RowContext>(() => {
    const items = new Map(view?.rows.map((row) => [row.item.id, row.item]));
    return {
      ...context,
      waiting: null,
      onOpenSession: setCurrent,
      messageOfEntry: (entryId) => {
        const itemId = view?.rowOf.get(entryId);
        const item = itemId ? items.get(itemId) : undefined;
        return item?.kind === "message" ? item : undefined;
      },
    };
  }, [context, view]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="session-view"
        showCloseButton={false}
        className="flex max-h-[85vh] w-[min(640px,94vw)] flex-col sm:max-w-none"
      >
        <div className="flex items-center justify-between gap-4">
          <DialogTitle className="truncate" dir="auto">
            {current.title}
          </DialogTitle>
          <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="icon-sm" />}>
            <X />
          </DialogClose>
        </div>
        {showSteps && read.entries ? (
          <RunDetails
            entries={read.entries}
            truncated={read.truncated}
            runId={current.kind === "run" ? current.runId : undefined}
          />
        ) : null}
        {read.failed ? (
          <div className="flex flex-col items-center gap-3 py-8 text-meta text-muted-foreground">
            <Trans>Could not load this chat.</Trans>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
              <Trans>Retry now</Trans>
            </Button>
          </div>
        ) : !view ? (
          <p className="py-8 text-center text-meta text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : (
          <div className="rk-scroll -mx-3 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 pb-2">
            {view.rows.map((row) => (
              <Fragment key={row.item.id}>
                {row.marker ? <RowMarker marker={row.marker} /> : null}
                <div className={row.firstOfGroup ? undefined : "-mt-2.75"}>
                  <ThreadRowBody
                    row={row}
                    context={rowContext}
                    chrome={rowChrome(row.item, showSteps)}
                    showAuthor={row.firstOfGroup}
                    showAvatar={row.lastOfGroup}
                    arrivesLive={false}
                  />
                </div>
              </Fragment>
            ))}
            {report ? (
              <div dir="auto">
                <ChatMarkdown>{truncateMarkdownForRender(report)}</ChatMarkdown>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A failed outcome as the server shows it: its classified kind, never the raw error. */
function withoutRawErrors(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "status" in value && "error" in value) {
    const { error, ...rest } = value as { status: unknown; error: unknown };
    if (rest.status === "failed" && typeof error === "string") {
      return { ...rest, failureKind: classifyRunFailure("failed", error) };
    }
  }
  return value;
}

/**
 * Debug mode's facts about the run the view shows (the named one, else the session's first),
 * read from its own log, and a copy of them with the entries to hand to someone.
 */
function RunDetails({
  entries,
  truncated,
  runId,
}: {
  entries: SessionEntry[];
  truncated?: true;
  runId?: string;
}) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const started = entries.find(
    (entry): entry is SessionEntryOf<"run.started"> =>
      entry.type === "run.started" && (!runId || entry.runId === runId),
  );
  // A run past the read's cap lost its start: nothing to say about it.
  if (!started) return null;
  const finished = entries.find(
    (entry): entry is SessionEntryOf<"run.finished"> =>
      entry.type === "run.finished" && entry.runId === started.runId,
  );
  const outcome = finished?.payload;
  const durationMs = finished ? Date.parse(finished.ts) - Date.parse(started.ts) : null;
  const run = {
    runId: started.runId,
    model: started.payload.model,
    effort: started.payload.effort,
    trigger: started.payload.trigger.kind,
    startedAt: started.ts,
    status: outcome?.status ?? "running",
    failureKind: outcome?.status === "failed" ? classifyRunFailure("failed", outcome.error) : null,
    usage: outcome?.usage ?? null,
    durationMs,
  };
  const facts = [
    `${run.model.provider}/${run.model.id}`,
    run.usage
      ? t`${run.usage.inputTokens.toLocaleString()} tokens in · ${run.usage.outputTokens.toLocaleString()} out`
      : null,
    durationMs === null ? null : formatShortDuration(durationMs),
    run.trigger,
  ].filter((fact) => fact !== null);
  const copy = () =>
    void navigator.clipboard
      ?.writeText(JSON.stringify({ run, truncated, entries }, withoutRawErrors, 2))
      .then(
        () => setCopied(true),
        () => undefined,
      );
  return (
    <div
      data-testid="run-details"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-meta text-muted-foreground"
    >
      <p className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap gap-x-1">
          {facts.map((fact, index) => (
            <span key={fact} className="whitespace-nowrap">
              {index > 0 ? "· " : null}
              {fact}
            </span>
          ))}
        </span>
        <span className="truncate font-mono text-mono select-all">{run.runId}</span>
      </p>
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? <Check /> : <Copy />}
        <Trans>Copy diagnostic</Trans>
      </Button>
    </div>
  );
}
