import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  hasVisibleMessagePresentation,
  messagePresentationSegments,
  stepsBlocks,
  visibleMessageBlocks,
} from "./message-presentation";

describe("mobile message presentation", () => {
  it("keeps only the blocks the thread draws", () => {
    const text = { kind: "text", text: "Hello" } as MessageBlock;
    const steps = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    } as MessageBlock;
    const activity = { kind: "progress", text: "Reading", activity: true } as MessageBlock;

    expect(visibleMessageBlocks([text, steps, activity])).toEqual([text]);
    expect(visibleMessageBlocks([text, steps, activity], true)).toEqual([text, steps]);
  });

  it("hides completed tool activity", () => {
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 1 },
          { label: "Message bot", count: 1 },
        ],
      },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
    ] as MessageBlock[];

    expect(messagePresentationSegments(blocks)).toEqual([
      {
        kind: "content",
        blocks: [{ kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" }],
      },
    ]);
    expect(
      hasVisibleMessagePresentation([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
    ).toBe(false);
  });

  it("keeps a takeover card visible with its steps hidden", () => {
    const steps = { kind: "steps", steps: [{ label: "Use browser", count: 1 }] } as MessageBlock;
    const computer = {
      kind: "computer",
      state: "Needs you",
      text: "Sign in to continue",
    } as MessageBlock;

    expect(hasVisibleMessagePresentation([steps, computer])).toBe(true);
    expect(visibleMessageBlocks([steps, computer])).toEqual([computer]);
    expect(visibleMessageBlocks([steps, computer], true)).toEqual([steps, computer]);
  });

  it("keeps steps-only messages visible when the setting is on", () => {
    const steps = [{ kind: "steps", steps: [{ label: "Read file", count: 1 }] }] as MessageBlock[];

    expect(hasVisibleMessagePresentation(steps)).toBe(false);
    expect(hasVisibleMessagePresentation(steps, true)).toBe(true);
    expect(stepsBlocks(steps)).toEqual(steps);
    expect(
      hasVisibleMessagePresentation(
        [{ kind: "progress", text: "Using browser", activity: true }],
        true,
      ),
    ).toBe(false);
  });

  it("hides marked activity without treating Using narration as a tool", () => {
    const activity = { kind: "progress", text: "Using browser", activity: true } as const;
    const narration = { kind: "progress", text: "Using browser is optional." } as const;

    expect(messagePresentationSegments([activity, narration])).toEqual([
      { kind: "content", blocks: [narration] },
    ]);

    const mixed: Extract<MessageBlock, { kind: "progress" }> = {
      kind: "progress",
      text: "Let me check",
      pendingToolNames: ["browser"],
    };
    expect(messagePresentationSegments([mixed])).toEqual([{ kind: "content", blocks: [mixed] }]);
  });

  it("keeps only response content around tool activity", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    expect(
      messagePresentationSegments([
        { kind: "text", text: "Checking." },
        tool,
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([
      {
        kind: "content",
        blocks: [
          { kind: "text", text: "Checking." },
          { kind: "text", text: "Done." },
        ],
      },
    ]);

    expect(
      messagePresentationSegments([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([{ kind: "content", blocks: [{ kind: "text", text: "Done." }] }]);
  });
});
