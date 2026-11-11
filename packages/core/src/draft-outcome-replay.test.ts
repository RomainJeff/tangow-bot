import type { MessageBlock } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { replacedDraftResult } from "./outbound-draft.js";

const replaced = (body: string) =>
  JSON.stringify(
    replacedDraftResult({
      status: "denied",
      draft: { state: "replaced", path: ["body"], proposed: "Hello." },
      request: { body },
    }),
    null,
    2,
  );
const LONG = `${"A long edited draft. ".repeat(40)}The end.`;
const output = replaced(LONG);

type Call = { output: string; outcome?: true };
const steps = (calls: Call[]): MessageBlock[] => [
  {
    kind: "steps",
    steps: [
      {
        label: "Run",
        count: calls.length,
        calls: calls.map((call, index) => ({
          name: "GMAIL_SEND_EMAIL",
          input: "{}",
          id: `call_${index}`,
          ...call,
        })),
      },
    ],
  },
];

describe("a card's outcome in the text replay of past steps", () => {
  it("keeps a replaced draft whole, where another result is cut", () => {
    const text = blocksToAgentHistoryText(
      steps([{ output, outcome: true }, { output: "x".repeat(1000) }]),
    );
    expect(text).toContain(LONG);
    expect(text).not.toContain("x".repeat(500));
  });

  it("cuts a tool result that looks like a replaced draft but is not a card's outcome", () => {
    const text = blocksToAgentHistoryText(steps([{ output }]));
    expect(text).not.toContain(LONG);
  });

  it("leaves the budget to the lines after it, so a later outcome is not dropped as omitted", () => {
    const sent = '{ "ok": true, "note": "The user sent this message from the draft card." }';
    const huge = replaced(`${"An edit longer than the whole budget. ".repeat(80)}The end.`);
    const text = blocksToAgentHistoryText(
      steps([{ output: huge, outcome: true }, { output: sent, outcome: true }, { output: "y" }]),
    );
    expect(text).toContain("The end.");
    expect(text).toContain("The user sent this message from the draft card.");
    expect(text).not.toContain("omitted");
  });

  it("keeps an outcome in a stretch with no room left for other results", () => {
    const filler = Array.from({ length: 12 }, () => ({ output: "y".repeat(300) }));
    const text = blocksToAgentHistoryText(steps([...filler, { output, outcome: true }]));
    expect(text).toContain(LONG);
    expect(text).toMatch(/\(\d+ more tool calls? omitted\)/);
  });
});
