import type { TaskTreeNode, ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { findTask, workActivityKey } from "./work-tree";
import { pendingWorkAsk, taskNode } from "./work-tree.fixtures";

const leaf = (workId: string, children: TaskTreeNode[] = []) => taskNode(workId, { children });

describe("findTask", () => {
  const tree = [leaf("a", [leaf("b", [leaf("c")])]), leaf("d")];

  it("finds a task at any level", () => {
    expect(findTask(tree, "c")?.workId).toBe("c");
    expect(findTask(tree, "missing")).toBeNull();
  });
});

describe("workActivityKey", () => {
  const returnMessage = (id: string): ThreadMessage => ({
    id,
    threadId: "thread-chief",
    seq: 1,
    role: "bot",
    blocks: [
      {
        kind: "card",
        lines: [
          { k: "purpose", v: "work_return" },
          { k: "outcome", v: "result" },
        ],
      },
    ],
    createdAt: "2026-10-02T08:00:00.000Z",
  });
  const textMessage: ThreadMessage = {
    ...returnMessage("text"),
    blocks: [{ kind: "text", text: "hello" }],
  };
  const ask = (runId: string) => pendingWorkAsk("work-1", runId);

  it("is empty while the thread holds no delegated work", () => {
    expect(workActivityKey([textMessage], undefined)).toBe("");
  });

  it("changes when a specialist returns or an approval appears or is settled", () => {
    const before = workActivityKey([returnMessage("m1")], []);
    expect(workActivityKey([returnMessage("m1"), returnMessage("m2")], [])).not.toBe(before);
    expect(workActivityKey([returnMessage("m1")], [ask("run-1")])).not.toBe(before);
    expect(workActivityKey([returnMessage("m1"), textMessage], [])).toBe(before);
  });
});
