import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { isToolActivityBlock, latestActivityLabel } from "./tool-activity.js";

describe("tool activity", () => {
  it.each<MessageBlock>([
    { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
    { kind: "progress", text: "Using browser", activity: true },
    { kind: "progress", text: "Using brex: list_expenses", activity: true },
  ])("recognizes $kind activity", (block) => {
    expect(isToolActivityBlock(block)).toBe(true);
  });

  it("keeps assistant narration separate from tool activity", () => {
    expect(isToolActivityBlock({ kind: "progress", text: "I’m checking that now." })).toBe(false);
    expect(isToolActivityBlock({ kind: "progress", text: "Using browser" })).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Let me check",
        pendingToolNames: ["browser"],
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({ kind: "progress", text: "Using the search results, I found it." }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using the search results, I found…",
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using these notes, here is a summary.",
      }),
    ).toBe(false);
    expect(isToolActivityBlock({ kind: "text", text: "Done." })).toBe(false);
  });
});

const liveRun = (blocks: MessageBlock[]) => [
  { id: "m1", blocks: [{ kind: "text" as const, text: "Sure." }] },
  { id: "progress:run-1", blocks },
];

describe("latestActivityLabel", () => {
  it("reads the tool line the run is on", () => {
    expect(
      latestActivityLabel(
        liveRun([{ kind: "progress", text: "Reading src/app.ts", activity: true }]),
      ),
    ).toBe("Reading src/app.ts");
  });

  it("ignores narration the transcript already shows", () => {
    expect(
      latestActivityLabel(liveRun([{ kind: "progress", text: "Let me look." }])),
    ).toBeUndefined();
  });

  it("stays undefined without a live run", () => {
    expect(
      latestActivityLabel([{ id: "m1", blocks: [{ kind: "text", text: "Done." }] }]),
    ).toBeUndefined();
  });
});
