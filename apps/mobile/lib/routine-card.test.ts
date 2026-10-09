import type { MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, settleRoutineAsk } from "@rakazo/core";
import { describe, expect, it } from "vitest";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

describe("the thread's routine card", () => {
  it("shows the routine and what became of it on an approval card the user allowed", () => {
    const actions = [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ];
    const allowed: AskBlock = {
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Review before schedule_create",
      status: "answered",
      answer: "allow",
      actions,
    };
    const settled = settleRoutineAsk(
      allowed,
      {
        id: "routine-1",
        name: "Stretch",
        schedule: "Every hour UTC",
        prompt: "Remind me to stretch",
        notify: false,
      },
      "updated",
    );
    expect(isApprovalAskBlock(settled)).toBe(true);
    expect(settled).toMatchObject({
      text: "Every hour UTC",
      actions,
      routine: {
        name: "Stretch",
        schedule: "Every hour UTC",
        prompt: "Remind me to stretch",
        notify: false,
      },
      created: { kind: "routine", id: "routine-1", label: "Stretch" },
      confirms: "updated",
    });
  });
});
