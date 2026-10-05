import { describe, expect, it } from "vitest";
import {
  emptyArrivalTracker,
  foldMessageArrivals,
  messageArrivalStaggerMs,
} from "./message-arrivals";

describe("foldMessageArrivals", () => {
  it("reports nothing new on a seeded pass (thread open)", () => {
    const { newIds, tracker } = foldMessageArrivals(
      emptyArrivalTracker(),
      [{ id: "a" }, { id: "b" }],
      { seed: true },
    );
    expect(newIds.size).toBe(0);
    expect(tracker.knownIds.has("a")).toBe(true);
    expect(tracker.knownIds.has("b")).toBe(true);
  });

  it("flags an id absent from the tracker as new", () => {
    const seeded = foldMessageArrivals(emptyArrivalTracker(), [{ id: "a" }], { seed: true });
    const { newIds } = foldMessageArrivals(seeded.tracker, [{ id: "a" }, { id: "b" }]);
    expect(newIds.has("b")).toBe(true);
    expect(newIds.has("a")).toBe(false);
  });

  it("does not re-flag an id once it has been folded in", () => {
    const seeded = foldMessageArrivals(emptyArrivalTracker(), [], { seed: true });
    const first = foldMessageArrivals(seeded.tracker, [{ id: "a" }]);
    expect(first.newIds.has("a")).toBe(true);
    const second = foldMessageArrivals(first.tracker, [{ id: "a" }]);
    expect(second.newIds.size).toBe(0);
  });

  it("treats 'Load earlier' (a seeded pass) as learned but never new, even for ids unseen before", () => {
    const seeded = foldMessageArrivals(emptyArrivalTracker(), [{ id: "recent" }], { seed: true });
    const olderLoaded = foldMessageArrivals(
      seeded.tracker,
      [{ id: "older-1" }, { id: "older-2" }, { id: "recent" }],
      { seed: true },
    );
    expect(olderLoaded.newIds.size).toBe(0);
    // A later real arrival still works normally against the now-larger tracker.
    const arrival = foldMessageArrivals(olderLoaded.tracker, [
      { id: "older-1" },
      { id: "older-2" },
      { id: "recent" },
      { id: "brand-new" },
    ]);
    expect([...arrival.newIds]).toEqual(["brand-new"]);
  });

  it("does not treat the server-id message replacing a progress row as new", () => {
    const seeded = foldMessageArrivals(emptyArrivalTracker(), [], { seed: true });
    // The progress placeholder arrives first, tied to a runId.
    const streaming = foldMessageArrivals(seeded.tracker, [
      { id: "progress:run-1", runId: "run-1" },
    ]);
    expect(streaming.newIds.has("progress:run-1")).toBe(true);
    // The final message replaces it: different id, same runId, in the same pass.
    const finalized = foldMessageArrivals(streaming.tracker, [
      { id: "msg-server-42", runId: "run-1" },
    ]);
    expect(finalized.newIds.size).toBe(0);
  });

  it("still flags a genuinely new bot message with no runId as new", () => {
    const seeded = foldMessageArrivals(emptyArrivalTracker(), [{ id: "a" }], { seed: true });
    const { newIds } = foldMessageArrivals(seeded.tracker, [{ id: "a" }, { id: "b" }]);
    expect(newIds.has("b")).toBe(true);
  });
});

describe("messageArrivalStaggerMs", () => {
  it("delays each subsequent arrival within the same second by 70ms", () => {
    const delays = messageArrivalStaggerMs([
      { id: "1", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", createdAt: "2026-01-01T00:00:00.200Z" },
      { id: "3", createdAt: "2026-01-01T00:00:00.400Z" },
    ]);
    expect(delays.get("1")).toBe(0);
    expect(delays.get("2")).toBe(70);
    expect(delays.get("3")).toBe(140);
  });

  it("caps the stagger at 4 bubbles", () => {
    const delays = messageArrivalStaggerMs(
      Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i * 100)).toISOString(),
      })),
    );
    expect(delays.get("3")).toBe(210);
    expect(delays.get("4")).toBe(210);
    expect(delays.get("5")).toBe(210);
  });

  it("starts a fresh, undelayed bucket once a gap exceeds a second", () => {
    const delays = messageArrivalStaggerMs([
      { id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", createdAt: "2026-01-01T00:00:00.500Z" },
      { id: "c", createdAt: "2026-01-01T00:00:05.000Z" },
    ]);
    expect(delays.get("a")).toBe(0);
    expect(delays.get("b")).toBe(70);
    expect(delays.get("c")).toBe(0);
  });

  it("sorts out-of-order input by createdAt before staggering", () => {
    const delays = messageArrivalStaggerMs([
      { id: "second", createdAt: "2026-01-01T00:00:00.200Z" },
      { id: "first", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(delays.get("first")).toBe(0);
    expect(delays.get("second")).toBe(70);
  });
});
