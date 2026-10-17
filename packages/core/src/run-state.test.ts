import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isActive, isWorkingStatus } from "./run-state.js";

describe("run state machine", () => {
  it("allows takeover resume onto a lease", () => {
    expect(canTransition("waiting_takeover", "leased")).toBe(true);
    expect(canTransition("waiting_takeover", "running")).toBe(false);
  });

  it("rejects rewriting a completed run", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/illegal/i);
  });

  it("never leaves a terminal state except failed retry", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("completed" as const, "cancelled" as const),
        fc.constantFrom(
          "queued" as const,
          "leased" as const,
          "running" as const,
          "waiting_input" as const,
          "completed" as const,
        ),
        (from, to) => {
          expect(canTransition(from, to)).toBe(false);
        },
      ),
    );
  });

  it.each([
    ["queued", true],
    ["leased", true],
    ["running", true],
    ["waiting_input", false],
    ["waiting_takeover", false],
    ["completed", false],
    ["idle", false],
    [undefined, false],
  ])("reads %s as working: %s", (status, working) => {
    expect(isWorkingStatus(status)).toBe(working);
  });

  it("keeps a run waiting on the person active, so Stop and locks stay", () => {
    expect(isActive("waiting_input")).toBe(true);
    expect(isWorkingStatus("waiting_input")).toBe(false);
  });
});
