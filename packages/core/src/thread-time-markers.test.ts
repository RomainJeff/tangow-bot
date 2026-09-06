import { describe, expect, it } from "vitest";
import {
  showsTimeMarker,
  THREAD_TIME_MARKER_GAP_MS,
  threadTimeMarkerLabel,
} from "./thread-time-markers.js";

/** Local wall-clock instant as ISO, so the day-boundary cases hold in any timezone. */
function localIso(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe("showsTimeMarker", () => {
  it("marks the first loaded message", () => {
    expect(showsTimeMarker(undefined, localIso(2026, 9, 2, 19))).toBe(true);
  });

  it("marks a new local calendar day even when the gap is short", () => {
    expect(showsTimeMarker(localIso(2026, 9, 2, 23, 50), localIso(2026, 9, 3, 0, 10))).toBe(true);
  });

  it("stays quiet inside one stretch of conversation", () => {
    expect(showsTimeMarker(localIso(2026, 9, 2, 19), localIso(2026, 9, 2, 22, 59))).toBe(false);
  });

  it("marks a return after the gap on the same day", () => {
    expect(showsTimeMarker(localIso(2026, 9, 2, 9), localIso(2026, 9, 2, 13))).toBe(true);
  });

  it("honours a caller-supplied gap", () => {
    const previous = localIso(2026, 9, 2, 9);
    const current = localIso(2026, 9, 2, 11);
    expect(showsTimeMarker(previous, current)).toBe(false);
    expect(showsTimeMarker(previous, current, 60 * 60 * 1000)).toBe(true);
  });

  it("defaults to a four-hour gap", () => {
    expect(THREAD_TIME_MARKER_GAP_MS).toBe(14_400_000);
  });

  it("skips the marker for an unparsable current timestamp", () => {
    expect(showsTimeMarker(localIso(2026, 9, 2, 9), "not-a-date")).toBe(false);
  });

  it("marks when the previous timestamp is unparsable", () => {
    expect(showsTimeMarker("not-a-date", localIso(2026, 9, 2, 9))).toBe(true);
  });
});

describe("threadTimeMarkerLabel", () => {
  const labels = { locale: "en-US", today: "Today", yesterday: "Yesterday" };
  const now = new Date(2026, 8, 4, 19, 13);

  it("names today and yesterday instead of a date", () => {
    expect(threadTimeMarkerLabel(localIso(2026, 9, 4, 9, 5), { ...labels, now })).toBe(
      "Today 9:05 AM",
    );
    expect(threadTimeMarkerLabel(localIso(2026, 9, 3, 21, 40), { ...labels, now })).toBe(
      "Yesterday 9:40 PM",
    );
  });

  it("spells out weekday and date further back", () => {
    expect(threadTimeMarkerLabel(localIso(2026, 9, 2, 19, 19), { ...labels, now })).toBe(
      "Wed, Sep 2 7:19 PM",
    );
  });

  it("returns an empty label for an unparsable timestamp", () => {
    expect(threadTimeMarkerLabel("not-a-date", { ...labels, now })).toBe("");
  });
});
