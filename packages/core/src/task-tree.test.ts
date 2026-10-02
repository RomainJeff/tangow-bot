import type { TaskApproval, TaskTreeNode } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  canCancelTask,
  canCloseTask,
  openDescendantCount,
  taskCount,
  taskDescendants,
  taskEngineLine,
  taskLineState,
} from "./task-tree.js";

function node(overrides: Partial<TaskTreeNode> & { workId: string }): TaskTreeNode {
  return {
    coordinator: { botId: "coordinator", threadId: "thread" },
    executor: {
      botId: `bot-${overrides.workId}`,
      threadId: `thread-${overrides.workId}`,
      name: "Scout",
    },
    harness: "default",
    executionTarget: null,
    harnessSource: null,
    harnessFallbackCause: null,
    missionComputerId: null,
    status: "active",
    working: false,
    parentScopedTaskId: null,
    rootScopedTaskId: overrides.workId,
    depth: 0,
    delegationCeiling: {},
    result: null,
    approvals: [],
    children: [],
    ...overrides,
  };
}

const finished = { runId: "run", outcome: "result" as const, text: "ok" };
const pendingApproval: TaskApproval = {
  effectId: "effect-1",
  summary: "Publish the brief",
  status: "pending",
  decidedBy: null,
};

describe("task line state", () => {
  it("reads a running task, one waiting on an approval, and each recorded outcome", () => {
    expect(taskLineState(node({ workId: "a" }))).toBe("running");
    expect(taskLineState(node({ workId: "a", approvals: [pendingApproval] }))).toBe("waiting");
    expect(
      taskLineState(node({ workId: "a", approvals: [{ ...pendingApproval, status: "allowed" }] })),
    ).toBe("running");
    for (const [outcome, state] of [
      ["result", "done"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["no_result", "no_result"],
    ] as const) {
      expect(taskLineState(node({ workId: "a", result: { ...finished, outcome } }))).toBe(state);
    }
  });

  it("keeps a task whose Run is going running after an earlier return", () => {
    expect(taskLineState(node({ workId: "a", result: finished, working: true }))).toBe("running");
    expect(
      taskLineState(
        node({ workId: "a", result: finished, working: true, approvals: [pendingApproval] }),
      ),
    ).toBe("waiting");
  });

  it("lets the server's terminal status win over a delivered outcome", () => {
    const result = finished;
    expect(taskLineState(node({ workId: "a", status: "closed", result }))).toBe("closed");
    expect(taskLineState(node({ workId: "a", status: "cancelled", result }))).toBe("cancelled");
  });
});

describe("task actions", () => {
  const openChild = node({ workId: "child" });
  const closedChild = node({ workId: "closed-child", status: "closed", result: finished });

  it("cancels any open task and nothing already closed or cancelled", () => {
    expect(canCancelTask(node({ workId: "a" }))).toBe(true);
    expect(canCancelTask(node({ workId: "a", status: "closed" }))).toBe(false);
    expect(canCancelTask(node({ workId: "a", status: "cancelled" }))).toBe(false);
  });

  it("closes only a task that returned, waits on nothing and has no open subtask", () => {
    expect(canCloseTask(node({ workId: "a", result: finished }))).toBe(true);
    expect(canCloseTask(node({ workId: "a" }))).toBe(false);
    expect(
      canCloseTask(node({ workId: "a", result: finished, approvals: [pendingApproval] })),
    ).toBe(false);
    // A follow-up that is still being worked on is cancelled, not closed.
    expect(canCloseTask(node({ workId: "a", result: finished, working: true }))).toBe(false);
    // A returned child is still open until it is closed: the server refuses otherwise.
    expect(
      canCloseTask(
        node({
          workId: "a",
          result: finished,
          children: [node({ workId: "b", result: finished })],
        }),
      ),
    ).toBe(false);
    expect(canCloseTask(node({ workId: "a", result: finished, children: [openChild] }))).toBe(
      false,
    );
    expect(canCloseTask(node({ workId: "a", result: finished, children: [closedChild] }))).toBe(
      true,
    );
    expect(canCloseTask(node({ workId: "a", status: "closed", result: finished }))).toBe(false);
  });

  it("counts the open tasks a cancel would stop, however deep", () => {
    const tree = node({
      workId: "root",
      children: [
        node({ workId: "b", children: [node({ workId: "c" }), closedChild] }),
        node({ workId: "d", status: "cancelled" }),
      ],
    });
    expect(taskDescendants(tree).map((task) => task.workId)).toEqual([
      "b",
      "c",
      "closed-child",
      "d",
    ]);
    expect(openDescendantCount(tree)).toBe(2);
    expect(openDescendantCount(openChild)).toBe(0);
  });

  it("counts the thread's own tasks, not the ones they delegated", () => {
    expect(taskCount([node({ workId: "a", children: [openChild] }), node({ workId: "b" })])).toBe(
      2,
    );
  });
});

describe("task engine line", () => {
  const reasonLabel = (reason: string) => `because ${reason}`;

  it("says the engine and, when it was recorded, why it was chosen", () => {
    expect(
      taskEngineLine({ harness: "codex-native", harnessSource: "explicit" }, reasonLabel),
    ).toBe("Codex · because explicit");
    // A judgment is read as an automatic pick.
    expect(taskEngineLine({ harness: "default", harnessSource: "judgment" }, reasonLabel)).toBe(
      "Rakazo · because automatic",
    );
  });

  it("names the engine alone for a task created before the choice was recorded", () => {
    expect(taskEngineLine({ harness: "claude-native", harnessSource: null }, reasonLabel)).toBe(
      "Claude",
    );
  });
});
