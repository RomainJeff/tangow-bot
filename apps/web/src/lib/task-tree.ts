import type {
  PendingWorkAsk,
  TaskApproval,
  TaskTreeNode,
  WorkReturnOutcome,
} from "@rakazo/contracts";

// The display rules of a task tree, in the names and semantics the other surfaces share
// (the mobile app reads them from @rakazo/core): swapping this module for that one changes
// no behavior.

/** The statuses that end a task: closed or cancelled. Any other status is open. */
const TERMINAL_WORK_STATUSES = ["closed", "cancelled"] as const;

function isTerminalWorkStatus(status: string): boolean {
  return TERMINAL_WORK_STATUSES.some((terminal) => terminal === status);
}

/** Where a task stands, as its tree line says it. */
export type TaskLineState =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled"
  | "no_result"
  | "closed";

const OUTCOME_STATE: Record<WorkReturnOutcome, TaskLineState> = {
  result: "done",
  failed: "failed",
  cancelled: "cancelled",
  no_result: "no_result",
};

/** Whether the task still takes work: anything the server has not closed or cancelled. */
export function isTaskOpen(node: Pick<TaskTreeNode, "status">): boolean {
  return !isTerminalWorkStatus(node.status);
}

export function hasPendingApproval(node: Pick<TaskTreeNode, "approvals">): boolean {
  return node.approvals.some((approval) => approval.status === "pending");
}

export function taskLineState(node: TaskTreeNode): TaskLineState {
  if (node.status === "closed") return "closed";
  if (node.status === "cancelled") return "cancelled";
  if (node.result && !node.working) return OUTCOME_STATE[node.result.outcome];
  return hasPendingApproval(node) ? "waiting" : "running";
}

/** Every task a task delegated, however deep. */
export function taskDescendants(node: TaskTreeNode): TaskTreeNode[] {
  return node.children.flatMap((child) => [child, ...taskDescendants(child)]);
}

/** The open tasks a cancel would stop with this one; a cancel always takes its whole subtree. */
export function openDescendantCount(node: TaskTreeNode): number {
  return taskDescendants(node).filter(isTaskOpen).length;
}

export function canCancelTask(node: TaskTreeNode): boolean {
  return isTaskOpen(node);
}

/**
 * Closing ends finished work: the task has returned, has no Run going or waiting on an
 * approval, and delegated nothing that is still open, which is what the server enforces too.
 */
export function canCloseTask(node: TaskTreeNode): boolean {
  return (
    isTaskOpen(node) &&
    node.result !== null &&
    !node.working &&
    !hasPendingApproval(node) &&
    openDescendantCount(node) === 0
  );
}

/** The thread's own delegated tasks: the count its "N tasks" link states. */
export function taskCount(roots: readonly TaskTreeNode[]): number {
  return roots.length;
}

/** Why a task runs on the harness it does, in the words a line gives; null when not recorded. */
export type TaskHarnessReason = "explicit" | "profile" | "automatic" | "default";

export function taskHarnessReason(
  node: Pick<TaskTreeNode, "harnessSource">,
): TaskHarnessReason | null {
  switch (node.harnessSource) {
    case "explicit":
      return "explicit";
    case "profile":
      return "profile";
    case "judgment":
      return "automatic";
    case "fallback":
      return "default";
    default:
      return null;
  }
}

/**
 * The pending ask that answers one of a task's approvals. A tree approval carries no run or
 * message of its own, so it is settled through the snapshot's pending ask of the same task and
 * effect; without one, the approval is shown but not actionable from here.
 */
export function pendingAskForApproval(
  pendingWork: readonly PendingWorkAsk[] | undefined,
  workId: string,
  approval: Pick<TaskApproval, "effectId" | "status">,
): PendingWorkAsk | null {
  if (approval.status !== "pending") return null;
  return (
    (pendingWork ?? []).find(
      (work) =>
        work.workId === workId &&
        work.message.blocks.some(
          (block) => block.kind === "ask" && block.approvalEffectId === approval.effectId,
        ),
    ) ?? null
  );
}
