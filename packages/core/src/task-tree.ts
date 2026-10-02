import type { TaskTreeNode } from "@rakazo/contracts";
import { isTerminalWorkStatus } from "@rakazo/contracts";
import { harnessName } from "./harness-name.js";
import type { TaskLineState } from "./work-return.js";
import { workReturnState } from "./work-return.js";

/** Whether the task still takes work: anything the server has not closed or cancelled. */
export function isTaskOpen(node: Pick<TaskTreeNode, "status">): boolean {
  return !isTerminalWorkStatus(node.status);
}

export function hasPendingApproval(node: Pick<TaskTreeNode, "approvals">): boolean {
  return node.approvals.some((approval) => approval.status === "pending");
}

/**
 * A task with a Run still going is working, or waiting when that Run is parked on an approval,
 * even after an earlier return; only without one does its latest return tell how it stands.
 */
export function taskLineState(node: TaskTreeNode): TaskLineState {
  if (node.status === "closed") return "closed";
  if (node.status === "cancelled") return "cancelled";
  if (node.result && !node.working) return workReturnState(node.result.outcome);
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
 * The engine a task runs on and why: `Engine · reason`, or the engine alone for a task created
 * before the choice was recorded. The surface supplies the reason in its own words.
 */
export function taskEngineLine(
  node: Pick<TaskTreeNode, "harness" | "harnessSource">,
  reasonLabel: (reason: TaskHarnessReason) => string,
): string {
  const reason = taskHarnessReason(node);
  const engine = harnessName(node.harness);
  return reason ? `${engine} · ${reasonLabel(reason)}` : engine;
}
