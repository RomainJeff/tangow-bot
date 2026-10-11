import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlocks } from "@rakazo/contracts";
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

  it("draws a message that only carries a skill line, and not one an older build cannot read", () => {
    const line = [
      {
        kind: "skill_source",
        skillUid: "0123456789abcdef0123456789abcdef",
        skillId: "user:coffee",
        name: "Coffee",
        change: "learned",
      },
    ];
    expect(hasRenderableBlock(MessageBlocks.parse(line), false)).toBe(true);
    // An older build does not know the kind and drops it while parsing.
    expect(
      hasRenderableBlock(MessageBlocks.parse([{ ...line[0], kind: "unknown_kind" }]), false),
    ).toBe(false);
  });

  it("does not count the preview's removal marker as something to draw", () => {
    const marker: MessageBlock = { kind: "link_preview", removed: true };
    const card: MessageBlock = {
      kind: "link_preview",
      url: "https://example.test/a",
      format: "compact",
      title: "A page",
    };
    expect(hasRenderableBlock([steps, marker], false)).toBe(false);
    expect(hasRenderableBlock([marker], true)).toBe(false);
    expect(hasRenderableBlock([steps, card], false)).toBe(true);
    expect(hasRenderableBlock([marker, { kind: "text", text: "hi" }], false)).toBe(true);
  });
});
