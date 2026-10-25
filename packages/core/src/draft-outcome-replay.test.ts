import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { isReplacedDraftOutput, replacedDraftResult } from "./outbound-draft.js";

const LONG = `${"A long edited draft. ".repeat(40)}The end.`;
const effect = {
  status: "denied",
  draft: { state: "replaced", path: ["body"], proposed: "Hello." },
  request: { body: LONG },
};
const output = JSON.stringify(replacedDraftResult(effect), null, 2);

const steps = (outputs: string[]): MessageBlock[] => [
  {
    kind: "steps",
    steps: [
      {
        label: "Run",
        count: outputs.length,
        calls: outputs.map((out, index) => ({
          name: "GMAIL_SEND_EMAIL",
          input: "{}",
          output: out,
          id: `call_${index}`,
        })),
      },
    ],
  },
];

describe("a replaced draft in the text replay of past steps", () => {
  it("is recognised by its result, and no other", () => {
    expect(isReplacedDraftOutput(output)).toBe(true);
    expect(isReplacedDraftOutput('{ "ok": false, "discarded": true }')).toBe(false);
    expect(isReplacedDraftOutput(`not json: ${output}`)).toBe(false);
  });

  it("keeps what the user left whole, where other results are cut", () => {
    const text = blocksToAgentHistoryText(steps([output, "x".repeat(1000)]));
    expect(text).toContain(LONG);
    expect(text).not.toContain("x".repeat(500));
  });

  it("keeps it in a stretch of steps that has no room left for other results", () => {
    const filler = Array.from({ length: 12 }, () => "y".repeat(300));
    const text = blocksToAgentHistoryText(steps([...filler, output]));
    expect(text).toContain(LONG);
    expect(text).toMatch(/\(\d+ more tool calls? omitted\)/);
  });
});
