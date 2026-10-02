import type { PendingWorkAsk, TaskApproval, TaskTreeNode } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  canCancelTask,
  canCloseTask,
  openDescendantCount,
  pendingAskForApproval,
  taskCount,
  taskHarnessReason,
  taskLineState,
} from "./task-tree";

function node(workId: string, overrides: Partial<TaskTreeNode> = {}): TaskTreeNode {
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

const done = { runId: "run-1", outcome: "result" as const, text: "All good" };
const pending: TaskApproval = {
  effectId: "effect-1",
  summary: "Write the note",
  status: "pending",
  decidedBy: null,
};

describe("taskLineState", () => {
  it("names a closure or a cancellation before anything its return said", () => {
    expect(taskLineState(node("a", { status: "closed", result: done }))).toBe("closed");
    expect(taskLineState(node("a", { status: "cancelled", result: done }))).toBe("cancelled");
  });

  it("reads how a delivered return ended", () => {
    expect(taskLineState(node("a", { result: done }))).toBe("done");
    expect(taskLineState(node("a", { result: { ...done, outcome: "failed" } }))).toBe("failed");
    expect(taskLineState(node("a", { result: { ...done, outcome: "no_result" } }))).toBe(
      "no_result",
    );
  });

  it("tells a task waiting on the owner from one still running", () => {
    expect(taskLineState(node("a", { approvals: [pending] }))).toBe("waiting");
    expect(taskLineState(node("a", { approvals: [{ ...pending, status: "allowed" }] }))).toBe(
      "running",
    );
  });
});

describe("task actions", () => {
  it("cancels any task the server has not closed or cancelled, returned or not", () => {
    expect(canCancelTask(node("a"))).toBe(true);
    expect(canCancelTask(node("a", { result: done }))).toBe(true);
    expect(canCancelTask(node("a", { status: "cancelled" }))).toBe(false);
    expect(canCancelTask(node("a", { status: "closed" }))).toBe(false);
  });

  it("closes only a returned task that waits on nothing and has nothing open below it", () => {
    expect(canCloseTask(node("a"))).toBe(false);
    expect(canCloseTask(node("a", { result: done }))).toBe(true);
    expect(canCloseTask(node("a", { status: "closed", result: done }))).toBe(false);
    expect(canCloseTask(node("a", { status: "cancelled", result: done }))).toBe(false);
    expect(canCloseTask(node("a", { result: done, approvals: [pending] }))).toBe(false);
    expect(canCloseTask(node("a", { result: done, children: [node("b")] }))).toBe(false);
    // A returned child is still open until it is closed: the server refuses otherwise.
    expect(canCloseTask(node("a", { result: done, children: [node("b", { result: done })] }))).toBe(
      false,
    );
    expect(
      canCloseTask(node("a", { result: done, children: [node("b", { status: "closed" })] })),
    ).toBe(true);
  });
});

describe("tree reading", () => {
  const tree = [
    node("a", {
      children: [
        node("b", { children: [node("c"), node("d", { status: "cancelled" })] }),
        node("e", { status: "closed" }),
      ],
    }),
    node("f"),
  ];

  it("counts the thread's own delegated tasks, not what they delegated", () => {
    expect(taskCount(tree)).toBe(2);
  });

  it("counts the open subtasks a cancellation would also stop", () => {
    expect(openDescendantCount(tree[0]!)).toBe(2);
    expect(openDescendantCount(tree[1]!)).toBe(0);
  });

  it("says why a harness was chosen, and nothing when it was not recorded", () => {
    expect(taskHarnessReason({ harnessSource: "judgment" })).toBe("automatic");
    expect(taskHarnessReason({ harnessSource: "fallback" })).toBe("default");
    expect(taskHarnessReason({ harnessSource: null })).toBeNull();
  });
});

describe("pendingAskForApproval", () => {
  const ask = (workId: string, effectId: string) =>
    ({
      workId,
      message: { blocks: [{ kind: "ask", approvalEffectId: effectId }] },
    }) as unknown as PendingWorkAsk;

  it("finds the ask of the same task and effect while the approval is pending", () => {
    const work = ask("a", "effect-1");
    expect(pendingAskForApproval([ask("b", "effect-1"), work], "a", pending)).toBe(work);
  });

  it("finds none for another effect, a settled approval or no asks at all", () => {
    expect(pendingAskForApproval([ask("a", "effect-2")], "a", pending)).toBeNull();
    expect(
      pendingAskForApproval([ask("a", "effect-1")], "a", { ...pending, status: "allowed" }),
    ).toBeNull();
    expect(pendingAskForApproval(undefined, "a", pending)).toBeNull();
  });
});
