import { Trans, useLingui } from "@lingui/react/macro";
import type { SessionEntry } from "@rakazo/contracts";
import { projectThreadView } from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import { rpc } from "../../lib/rpc";
import type { SessionViewTarget } from "../../lib/thread-items";
import type { RowContext } from "./thread-row";
import { drawsNothing, RowMarker, rowChrome, ThreadRowBody } from "./thread-row";

type Read = { entries: SessionEntry[] | null; failed: boolean };

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
  const showSteps = useDisplayAgentSteps();
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
      ({ entries }) => {
        if (!abort.signal.aborted) setRead({ entries, failed: false });
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
              drawsNothing(item, showSteps) ||
              (item.kind === "routine" && current.kind === "run" && item.runId === current.runId),
          })
        : null,
    [read.entries, showSteps, current],
  );
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
