import type { MessageBlock, TaskApproval, TaskTreeNode } from "@rakazo/contracts";
import type { TaskHarnessReason } from "@rakazo/core";
import {
  canCancelTask,
  canCloseTask,
  openDescendantCount,
  parseWorkReturn,
  taskEngineLine,
} from "@rakazo/core";
import { t, tPlural } from "./i18n";

function harnessReasonLabel(reason: TaskHarnessReason): string {
  switch (reason) {
    case "explicit":
      return t("chosen explicitly");
    case "profile":
      return t("set by its profile");
    case "automatic":
      return t("picked automatically");
    case "default":
      return t("default");
  }
}

/** The engine a task runs on and why, in the active language. */
export function engineLine(node: TaskTreeNode): string {
  return taskEngineLine(node, harnessReasonLabel);
}

export function tasksLinkLabel(count: number): string {
  return tPlural(count, { one: "{count} task", other: "{count} tasks" });
}

export type TaskMenuAction = "cancel" | "close" | "thread";

/** What the line's menu offers: an action only when it is possible, and the thread always. */
export function taskMenuActions(node: TaskTreeNode): TaskMenuAction[] {
  return [
    ...(canCancelTask(node) ? (["cancel"] as const) : []),
    ...(canCloseTask(node) ? (["close"] as const) : []),
    "thread",
  ];
}

export function taskMenuLabel(action: TaskMenuAction): string {
  return action === "cancel" ? t("Cancel") : action === "close" ? t("Close") : t("View thread");
}

/** The confirmation a cancel asks for, announcing the open subtasks it stops with the task. */
export function cancelPrompt(node: TaskTreeNode): { title: string; message: string | undefined } {
  const open = openDescendantCount(node);
  return {
    title: t("Cancel {name}?", { name: node.executor.name || t("Specialist") }),
    message:
      open === 0
        ? undefined
        : tPlural(open, {
            one: "Its open subtask will be cancelled too.",
            other: "Its {count} open subtasks will be cancelled too.",
          }),
  };
}

/**
 * An approval's line: what was asked, and once settled who decided it. Without a name the
 * approval card's own outcome words stand in.
 */
export function approvalLine(approval: TaskApproval, ownerName: string | null): string {
  if (approval.status === "pending") return approval.summary;
  if (!ownerName) {
    const outcome =
      approval.status === "allowed"
        ? t("Allowed once")
        : approval.status === "always_allowed"
          ? t("Always allowed")
          : t("Denied");
    return `${approval.summary} · ${outcome}`;
  }
  const decision =
    approval.status === "allowed"
      ? t("allowed by {name}", { name: ownerName })
      : approval.status === "always_allowed"
        ? t("always allowed by {name}", { name: ownerName })
        : t("denied by {name}", { name: ownerName });
  return `${approval.summary} · ${decision}`;
}

/** Whether an event changes the thread's task tree, so an open tree is read again. */
export function eventTouchesTaskTree(event: {
  type: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (event.type.startsWith("work.")) return true;
  if (event.type !== "thread.message.created" && event.type !== "thread.message.updated") {
    return false;
  }
  const blocks = event.payload?.blocks;
  return (
    Array.isArray(blocks) && blocks.some((block) => parseWorkReturn(block as MessageBlock) !== null)
  );
}
