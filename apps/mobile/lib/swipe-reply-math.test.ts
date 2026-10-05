import { describe, expect, it } from "vitest";
import {
  crossedSwipeReplyThreshold,
  hasCrossedSwipeReplyThreshold,
  resistedSwipeOffset,
  SWIPE_REPLY_THRESHOLD_PX,
  SWIPE_RESISTANCE_START_PX,
} from "./swipe-reply-math";

describe("resistedSwipeOffset", () => {
  it("follows the finger 1:1 up to the resistance start", () => {
    expect(resistedSwipeOffset(0)).toBe(0);
    expect(resistedSwipeOffset(20)).toBe(20);
    expect(resistedSwipeOffset(SWIPE_RESISTANCE_START_PX)).toBe(SWIPE_RESISTANCE_START_PX);
  });

  it("scales drag beyond the resistance start by the resistance factor", () => {
    // 40 + (60 - 40) * 0.6 = 52
    expect(resistedSwipeOffset(60)).toBeCloseTo(52);
  });

  it("never moves the bubble for a leftward drag", () => {
    expect(resistedSwipeOffset(-10)).toBe(0);
    expect(resistedSwipeOffset(-100)).toBe(0);
  });
});

describe("hasCrossedSwipeReplyThreshold", () => {
  it("is false below the threshold and true at or beyond it", () => {
    expect(hasCrossedSwipeReplyThreshold(SWIPE_REPLY_THRESHOLD_PX - 1)).toBe(false);
    expect(hasCrossedSwipeReplyThreshold(SWIPE_REPLY_THRESHOLD_PX)).toBe(true);
    expect(hasCrossedSwipeReplyThreshold(SWIPE_REPLY_THRESHOLD_PX + 10)).toBe(true);
  });
});

describe("crossedSwipeReplyThreshold", () => {
  it("fires exactly once as the drag passes the threshold", () => {
    // Resisted offsets stay under the raw px value once past the resistance
    // start, so use raw distances comfortably on each side once resisted.
    const before = 60; // resisted ~52, under threshold
    const after = 90; // resisted 40 + 50*0.6 = 70, over threshold
    expect(crossedSwipeReplyThreshold(before, after)).toBe(true);
    // Once already past, a further update does not re-cross.
    expect(crossedSwipeReplyThreshold(after, 120)).toBe(false);
  });

  it("does not report a crossing while retreating back under the threshold", () => {
    expect(crossedSwipeReplyThreshold(90, 60)).toBe(false);
  });

  it("does not report a crossing when both points are already past it", () => {
    expect(crossedSwipeReplyThreshold(90, 100)).toBe(false);
  });
});

describe("swipe math on the UI thread", () => {
  // The pan gesture calls these from its UI-thread callbacks; without the
  // directive Reanimated throws there and the app aborts mid-swipe.
  it("marks every helper as a worklet", () => {
    for (const helper of [
      resistedSwipeOffset,
      hasCrossedSwipeReplyThreshold,
      crossedSwipeReplyThreshold,
    ]) {
      expect(helper.toString()).toContain("worklet");
    }
  });
});
