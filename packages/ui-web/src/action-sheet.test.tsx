import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ActionSheet,
  DRAG_CLOSE_THRESHOLD_PX,
  shouldCloseActionSheetDrag,
} from "./action-sheet.js";

describe("shouldCloseActionSheetDrag (B6)", () => {
  it("snaps back short of the 80px threshold", () => {
    expect(shouldCloseActionSheetDrag(40, 400)).toBe(false);
    expect(shouldCloseActionSheetDrag(DRAG_CLOSE_THRESHOLD_PX, 400)).toBe(false);
  });

  it("closes once the drag passes 80px, however slow", () => {
    expect(shouldCloseActionSheetDrag(DRAG_CLOSE_THRESHOLD_PX + 1, 2_000)).toBe(true);
  });

  it("closes on a fast flick that never reaches 80px", () => {
    expect(shouldCloseActionSheetDrag(30, 20)).toBe(true);
  });

  it("ignores an upward drag (never closes on a swipe up)", () => {
    expect(shouldCloseActionSheetDrag(-120, 20)).toBe(false);
  });
});

// Base UI's `Dialog` only renders its portalled content once mounted in a
// real DOM (same as the existing `components/ui/dialog.tsx`, which has no
// renderToString test of its own for the same reason) — `renderToString`
// itself yields no popup markup to assert on. This is a smoke test that the
// primitive composes without throwing, open or closed.
describe("ActionSheet", () => {
  it("renders without throwing while open", () => {
    expect(() =>
      renderToString(
        <ActionSheet open title="Message actions" onOpenChange={() => {}}>
          <button type="button">Reply</button>
        </ActionSheet>,
      ),
    ).not.toThrow();
  });

  it("renders without throwing while closed", () => {
    expect(() =>
      renderToString(
        <ActionSheet open={false} title="Message actions" onOpenChange={() => {}}>
          <button type="button">Reply</button>
        </ActionSheet>,
      ),
    ).not.toThrow();
  });
});
