import type { PendingWorkAsk } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { answerableWorkAsks } from "./work-cards";

function pending(blocks: PendingWorkAsk["message"]["blocks"], runId = "run-1"): PendingWorkAsk {
  return {
    workId: "work-1",
    rootWorkId: "work-1",
    depth: 0,
    coordinator: { botId: "bot-coordinator", name: "Planner" },
    specialist: { botId: "bot-specialist", name: "Scout" },
    runId,
    message: {
      id: "message-1",
      threadId: "thread-work",
      seq: 1,
      role: "bot",
      createdAt: "2026-10-02T08:00:00.000Z",
      blocks,
    },
  };
}

describe("answerable work asks", () => {
  it("keeps the pending works whose message carries an ask", () => {
    const withAsk = pending([{ kind: "ask", text: "Publish?", actions: [] }]);
    const withoutAsk = pending([{ kind: "text", text: "Working" }], "run-2");
    expect(answerableWorkAsks([withAsk, withoutAsk])).toEqual([withAsk]);
  });

  it("is empty without a pending work", () => {
    expect(answerableWorkAsks(undefined)).toEqual([]);
  });
});
