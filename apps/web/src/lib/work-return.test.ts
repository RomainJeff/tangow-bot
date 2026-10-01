import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseWorkReturn } from "./work-return";

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

  it("ignores cards that are not specialist returns", () => {
    expect(parseWorkReturn(card([{ k: "purpose", v: "webhook" }]))).toBeNull();
  });

  it("ignores blocks that are not cards", () => {
    expect(parseWorkReturn({ kind: "text", text: "plain message" })).toBeNull();
  });
});
