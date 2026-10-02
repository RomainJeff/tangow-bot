import type { PendingWorkAsk, TaskTreeNode } from "@rakazo/contracts";

/** A task that has not returned, with no approval and nothing delegated; tests override what they read. */
export function taskNode(workId: string, overrides: Partial<TaskTreeNode> = {}): TaskTreeNode {
  return {
    workId,
    coordinator: { botId: "bot-chief", threadId: "thread-chief" },
    executor: { botId: `bot-${workId}`, threadId: `thread-${workId}`, name: workId },
    harness: "default",
    executionTarget: null,
    harnessSource: "fallback",
    harnessFallbackCause: null,
    missionComputerId: null,
    status: "dispatched",
    working: false,
    parentScopedTaskId: null,
    rootScopedTaskId: workId,
    depth: 0,
    delegationCeiling: {},
    result: null,
    approvals: [],
    children: [],
    ...overrides,
  };
}

/** A specialist's pending approval ask, as the coordinator's snapshot carries it. */
export function pendingWorkAsk(workId: string, runId = "run-1"): PendingWorkAsk {
  return {
    workId,
    rootWorkId: workId,
    depth: 0,
    coordinator: { botId: "bot-chief", name: "Chief" },
    specialist: { botId: `bot-${workId}`, name: workId },
    runId,
    message: {
      id: "message-1",
      threadId: `thread-${workId}`,
      seq: 1,
      role: "bot",
      createdAt: "2026-10-02T08:00:00.000Z",
      blocks: [
        {
          kind: "ask",
          approvalEffectId: "effect-1",
          text: "Publish the brief",
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    },
  };
}
