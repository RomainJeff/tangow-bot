import { t } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { TaskTreeNode } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";
import { openDescendantCount } from "../../lib/task-tree";
import { findTask } from "../../lib/work-tree";
import type { WorkTreeValue } from "./context";
import { WorkTreeContext } from "./context";
import { WorkThreadDialog } from "./WorkThreadDialog";

/**
 * Keeps the task tree of one coordinator thread, so its work cards can unfold it. The tree is
 * read from the backend when the thread shows delegated work and read again each time that
 * work moves (`activityKey`) or the server says the tree changed (`changes`); every decision is
 * the backend's, this only relays the intent. It holds one thread's tree: mount it per thread.
 */
export function WorkTreeProvider({
  threadId,
  activityKey,
  changes,
  deciderName,
  children,
}: {
  threadId?: string;
  activityKey: string;
  /** Counts the server's `work.tree_changed` events for this thread. */
  changes: number;
  deciderName?: string;
  children: ReactNode;
}) {
  const [tasks, setTasks] = useState<readonly TaskTreeNode[]>([]);
  const [reload, setReload] = useState(0);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ workId: string; message: string } | null>(null);

  useEffect(() => {
    if (!threadId || activityKey === "") return;
    let stale = false;
    rpc.works
      .tree({ threadId })
      .then((loaded) => {
        if (!stale) setTasks(loaded);
      })
      // The tree is a secondary read: a failure keeps what was shown and the next change retries.
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [threadId, activityKey, changes, reload]);

  const decide = useCallback(
    async (node: TaskTreeNode, call: (input: { workId: string }) => Promise<unknown>) => {
      setActionError(null);
      try {
        await call({ workId: node.workId });
      } catch (error) {
        setActionError({
          workId: node.workId,
          message: error instanceof Error ? error.message : t`Could not complete action`,
        });
      }
      setReload((count) => count + 1);
    },
    [],
  );

  const value = useMemo<WorkTreeValue>(
    () => ({
      tasks,
      openCard,
      toggle: (cardKey) => setOpenCard((current) => (current === cardKey ? null : cardKey)),
      deciderName,
      errorFor: (workId) => (actionError?.workId === workId ? actionError.message : null),
      onCancel: (node) => setCancelId(node.workId),
      onClose: (node) => void decide(node, rpc.works.close),
      onViewThread: (node) => setViewId(node.workId),
    }),
    [tasks, openCard, deciderName, actionError, decide],
  );

  const cancelTarget = cancelId ? findTask(tasks, cancelId) : null;
  return (
    <>
      <WorkTreeContext.Provider value={value}>
        {children}
        <CancelTaskDialog
          node={cancelTarget}
          onKeep={() => setCancelId(null)}
          onConfirm={(node) => {
            setCancelId(null);
            void decide(node, rpc.works.cancel);
          }}
        />
      </WorkTreeContext.Provider>
      {/* A specialist's thread is read, not worked in: outside the tree it was opened from. */}
      <WorkThreadDialog
        node={viewId ? findTask(tasks, viewId) : null}
        onClose={() => setViewId(null)}
      />
    </>
  );
}

function CancelTaskDialog({
  node,
  onKeep,
  onConfirm,
}: {
  node: TaskTreeNode | null;
  onKeep: () => void;
  onConfirm: (node: TaskTreeNode) => void;
}) {
  const { t } = useLingui();
  const name = node?.executor.name || t`Specialist`;
  const count = node ? openDescendantCount(node) : 0;
  return (
    <AlertDialog open={node !== null} onOpenChange={(open) => (open ? null : onKeep())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Cancel ${name}?`}</AlertDialogTitle>
          {count > 0 ? (
            <AlertDialogDescription>
              <Plural
                value={count}
                one="Its open subtask will be cancelled too."
                other={`Its ${count} open subtasks will be cancelled too.`}
              />
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep`}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => node && onConfirm(node)}>
            {t`Cancel task`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
