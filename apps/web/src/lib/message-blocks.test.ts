import type { MessageBlock } from "@rakazo/contracts";
import { botColors } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { hasRenderableBlock, isHiddenActivityBlock } from "./message-blocks";

const steps: MessageBlock = { kind: "steps", steps: [{ label: "Read file", count: 1 }] };

describe("isHiddenActivityBlock", () => {
  it("hides tool activity, and keeps steps once the pref is on", () => {
    expect(isHiddenActivityBlock(steps, false)).toBe(true);
    expect(isHiddenActivityBlock(steps, true)).toBe(false);
    expect(isHiddenActivityBlock({ kind: "text", text: "Done." }, false)).toBe(false);
  });
});

describe("hasRenderableBlock", () => {
  it("says a message has something to show", () => {
    expect(hasRenderableBlock([{ kind: "text", text: "Done." }], false)).toBe(true);
    expect(hasRenderableBlock([steps], true)).toBe(true);
  });

  it("says a message with nothing this version draws has not", () => {
    // A row of avatar, name and time around an empty body is the bug this guards.
    expect(hasRenderableBlock([{ kind: "reasoning", text: "thinking out loud" }], true)).toBe(
      false,
    );
    expect(
      hasRenderableBlock(
        [{ kind: "connect", name: "GitHub", initial: "G", color: botColors[0], status: "pending" }],
        true,
      ),
    ).toBe(false);
    expect(hasRenderableBlock([steps], false)).toBe(false);
    expect(hasRenderableBlock([], true)).toBe(false);
  });
});
