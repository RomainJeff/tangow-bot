import type { PendingWorkAsk, TaskTreeNode, ThreadMessage } from "@rakazo/contracts";
import { parseWorkReturn } from "@rakazo/core";

export function findTask(nodes: readonly TaskTreeNode[], workId: string): TaskTreeNode | null {
  for (const node of nodes) {
    if (node.workId === workId) return node;
    const found = findTask(node.children, workId);
    if (found) return found;
  }
  return null;
}

/**
 * Changes whenever the coordinator thread learns of delegated work moving: a specialist
 * returned, or an approval appeared or was settled. The tree is read again when it changes.
 */
export function workActivityKey(
  messages: readonly ThreadMessage[],
  pendingWork: readonly PendingWorkAsk[] | undefined,
): string {
  const returns = messages
    .filter((message) => message.blocks.some((block) => parseWorkReturn(block) !== null))
    .map((message) => message.id);
  const asks = (pendingWork ?? []).map((ask) => ask.runId);
  return [...returns, ...asks].join("|");
}
