import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseWorkReturn, taskStateTone, workReturnState } from "./work-return.js";

function card(lines: Array<{ k: string; v: string }>): MessageBlock {
  return { kind: "card", lines };
}

const workReturnLines = (
  outcome: { k: string; v: string } | null,
): Array<{ k: string; v: string }> => [
  { k: "purpose", v: "work_return" },
  { k: "workId", v: "work-1" },
  { k: "rootScopedTaskId", v: "root-1" },
  ...(outcome ? [outcome] : []),
  { k: "executorBotId", v: "bot-specialist" },
];

describe("parseWorkReturn", () => {
  it("reads a successful specialist return", () => {
    expect(parseWorkReturn(card(workReturnLines({ k: "outcome", v: "result" })))).toEqual({
      workId: "work-1",
      executorBotId: "bot-specialist",
      outcome: "result",
    });
  });

  it("reads a failed specialist return", () => {
    expect(parseWorkReturn(card(workReturnLines({ k: "outcome", v: "failed" })))).toEqual({
      workId: "work-1",
      executorBotId: "bot-specialist",
      outcome: "failed",
    });
  });

  it.each(["cancelled", "no_result"] as const)("reads a %s specialist return", (outcome) => {
    expect(parseWorkReturn(card(workReturnLines({ k: "outcome", v: outcome })))).toEqual({
      workId: "work-1",
      executorBotId: "bot-specialist",
      outcome,
    });
  });

  it("reads a legacy return without an outcome line as unknown, never as a success", () => {
    expect(parseWorkReturn(card(workReturnLines(null)))).toEqual({
      workId: "work-1",
      executorBotId: "bot-specialist",
      outcome: "unknown",
    });
  });

  it("carries the specialist's name when the card recorded it", () => {
    const lines = [
      ...workReturnLines({ k: "outcome", v: "result" }),
      { k: "executorBotName", v: "Scout" },
    ];
    expect(parseWorkReturn(card(lines))).toMatchObject({ executorBotName: "Scout" });
  });

  it("ignores cards that are not specialist returns", () => {
    expect(parseWorkReturn(card([{ k: "purpose", v: "webhook" }]))).toBeNull();
  });

  it("ignores blocks that are not cards", () => {
    expect(parseWorkReturn({ kind: "text", text: "plain message" })).toBeNull();
  });
});

describe("work return state", () => {
  it("reads each recorded outcome as the state it ends a task in, and a legacy return as none", () => {
    expect(workReturnState("result")).toBe("done");
    expect(workReturnState("no_result")).toBe("no_result");
    expect(workReturnState("unknown")).toBeNull();
  });

  it("draws only the ends that are not neutral in a color of their own", () => {
    expect(taskStateTone("done")).toBe("success");
    expect(taskStateTone("failed")).toBe("destructive");
    expect(taskStateTone("closed")).toBe("muted");
    expect(taskStateTone("waiting")).toBeNull();
  });
});
