import { describe, expect, it } from "vitest";
import type { ScreenAssignment } from "./supervisor-logic.js";
import { keepReleasedScreen, nextScreenIndex, releaseAssignedScreen } from "./supervisor-logic.js";

function keptSlot(lease: string) {
  const assigned = new Map<string, ScreenAssignment>();
  const index = nextScreenIndex(assigned, "writer", lease);
  expect(releaseAssignedScreen(assigned, "writer", lease)).toBe(index);
  keepReleasedScreen(assigned, "writer", index);
  return assigned;
}

describe("a screen kept after a run", () => {
  it("is taken by the bot's next run at the same index, even on a first claim", () => {
    const assigned = keptSlot("run-a:1");

    expect(nextScreenIndex(assigned, "writer", "run-b:1")).toBe(0);
    expect(assigned.get("writer")?.leaseId).toBe("run-b:1");
    expect(nextScreenIndex(assigned, "researcher")).toBe(1);
  });

  it("stops being kept once the next run owns it", () => {
    const assigned = keptSlot("run-a:1");
    nextScreenIndex(assigned, "writer", "run-b:1");

    expect(() => nextScreenIndex(assigned, "writer", "run-c:1")).toThrow(
      /owned by a newer execution/,
    );
  });

  it("rejects a run whose fence is lower than the kept one", () => {
    const assigned = keptSlot("run-a:3");

    expect(() => nextScreenIndex(assigned, "writer", "run-b:2")).toThrow(
      /owned by a newer execution/,
    );
    expect(nextScreenIndex(assigned, "writer", "run-b:3")).toBe(0);
  });

  it("does not let the previous run's release close the slot after the next run took it", () => {
    const assigned = keptSlot("run-a:1");
    nextScreenIndex(assigned, "writer", "run-b:1");

    expect(releaseAssignedScreen(assigned, "writer", "run-a:1")).toBeUndefined();
    expect(releaseAssignedScreen(assigned, "writer", "run-b:1")).toBe(0);
  });

  it("is still released by its own run's idle timeout and by a release without a lease", () => {
    expect(releaseAssignedScreen(keptSlot("run-a:1"), "writer", "run-a:1")).toBe(0);
    expect(releaseAssignedScreen(keptSlot("run-a:1"), "writer")).toBe(0);
  });

  it("stays reachable without a lease, as a viewer's request is", () => {
    const assigned = keptSlot("run-a:1");

    expect(nextScreenIndex(assigned, "writer")).toBe(0);
    expect(nextScreenIndex(assigned, "writer", "run-b:1")).toBe(0);
  });
});

describe("a screen that was not kept", () => {
  it("still rejects another run's first claim at the same fence", () => {
    const assigned = new Map<string, ScreenAssignment>();
    nextScreenIndex(assigned, "writer", "run-a:1");

    expect(() => nextScreenIndex(assigned, "writer", "run-b:1")).toThrow(
      /owned by a newer execution/,
    );
  });
});
