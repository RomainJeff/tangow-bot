import type { TaskApproval, TaskTreeNode } from "@rakazo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { resetI18nForTests } from "./i18n";
import {
  approvalLine,
  cancelPrompt,
  engineLine,
  eventTouchesTaskTree,
  taskMenuActions,
  tasksLinkLabel,
} from "./task-tree-view";

function node(overrides: Partial<TaskTreeNode> = {}): TaskTreeNode {
  return {
    workId: "work-1",
    coordinator: { botId: "coordinator", threadId: "thread" },
    executor: { botId: "specialist", threadId: "thread-work", name: "Scout" },
    harness: "default",
    executionTarget: null,
    harnessSource: null,
    harnessFallbackCause: null,
    missionComputerId: null,
    status: "active",
    working: false,
    parentScopedTaskId: null,
    rootScopedTaskId: "work-1",
    depth: 0,
    delegationCeiling: {},
    result: null,
    approvals: [],
    children: [],
    ...overrides,
  };
}

const done = { runId: "run", outcome: "result" as const, text: "ok" };

beforeEach(() => resetI18nForTests("en"));

describe("task tree lines", () => {
  it("says the engine and why it was chosen, in the active language", () => {
    const task = node({ harness: "claude-native", harnessSource: "judgment" });
    expect(engineLine(task)).toBe("Claude · picked automatically");
    resetI18nForTests("ru");
    expect(engineLine(task)).toBe("Claude · выбрано автоматически");
  });

  it("names only the engine when the choice was never recorded", () => {
    expect(engineLine(node({ harness: "codex-native" }))).toBe("Codex");
  });

  it("counts tasks in the singular and the plural", () => {
    expect(tasksLinkLabel(1)).toBe("1 task");
    expect(tasksLinkLabel(3)).toBe("3 tasks");
  });
});

describe("task menu", () => {
  it("offers cancel while the task is open, close once it returned, and the thread always", () => {
    expect(taskMenuActions(node())).toEqual(["cancel", "thread"]);
    expect(taskMenuActions(node({ result: done }))).toEqual(["cancel", "close", "thread"]);
    expect(taskMenuActions(node({ status: "closed", result: done }))).toEqual(["thread"]);
  });

  it("holds back close while a subtask is open", () => {
    const open = node({ workId: "child" });
    expect(taskMenuActions(node({ result: done, children: [open] }))).toEqual(["cancel", "thread"]);
  });
});

describe("cancel prompt", () => {
  it("names the task and announces the open subtasks it takes down", () => {
    const child = node({ workId: "c1" });
    const settled = node({ workId: "c2", status: "closed", result: done });
    expect(cancelPrompt(node())).toEqual({ title: "Cancel Scout?", message: undefined });
    expect(cancelPrompt(node({ children: [child, settled] })).message).toBe(
      "Its open subtask will be cancelled too.",
    );
    expect(cancelPrompt(node({ children: [child, node({ workId: "c3" })] })).message).toBe(
      "Its 2 open subtasks will be cancelled too.",
    );
  });
});

describe("cancel prompt in Russian", () => {
  it("agrees the open subtasks with their number", () => {
    resetI18nForTests("ru");
    const open = (count: number) =>
      node({
        children: Array.from({ length: count }, (_, index) => node({ workId: `c${index}` })),
      });
    expect(cancelPrompt(open(1)).message).toBe("Его 1 открытая подзадача тоже будет отменена.");
    expect(cancelPrompt(open(3)).message).toBe("Его 3 открытые подзадачи тоже будут отменены.");
    expect(cancelPrompt(open(5)).message).toBe("Его 5 открытых подзадач тоже будут отменены.");
  });
});

describe("approval line", () => {
  const approval = (status: TaskApproval["status"]): TaskApproval => ({
    effectId: "effect",
    summary: "Publish the brief",
    status,
    decidedBy: status === "pending" ? null : "user",
  });

  it("says who settled it", () => {
    expect(approvalLine(approval("pending"), "Pierre")).toBe("Publish the brief");
    expect(approvalLine(approval("allowed"), "Pierre")).toBe(
      "Publish the brief · allowed by Pierre",
    );
    expect(approvalLine(approval("always_allowed"), "Pierre")).toBe(
      "Publish the brief · always allowed by Pierre",
    );
    expect(approvalLine(approval("denied"), "Pierre")).toBe("Publish the brief · denied by Pierre");
  });

  it("falls back to the card's outcome words while the name is unknown", () => {
    expect(approvalLine(approval("allowed"), null)).toBe("Publish the brief · Allowed once");
    expect(approvalLine(approval("denied"), null)).toBe("Publish the brief · Denied");
  });
});

describe("events that change the tree", () => {
  it("reads work events and a specialist's return card", () => {
    expect(eventTouchesTaskTree({ type: "work.input_answered" })).toBe(true);
    expect(eventTouchesTaskTree({ type: "work.tree_changed" })).toBe(true);
    expect(
      eventTouchesTaskTree({
        type: "thread.message.created",
        payload: {
          blocks: [{ kind: "card", lines: [{ k: "purpose", v: "work_return" }] }],
        },
      }),
    ).toBe(true);
  });

  it("ignores everything else", () => {
    expect(eventTouchesTaskTree({ type: "thread.progress" })).toBe(false);
    expect(
      eventTouchesTaskTree({
        type: "thread.message.created",
        payload: { blocks: [{ kind: "text", text: "hi" }] },
      }),
    ).toBe(false);
  });
});
