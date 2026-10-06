import { describe, expect, it } from "vitest";
import { executionBlocksUserTakeover, toComputerStatus } from "./computer-status.js";

const baseComputer = {
  id: "computer-1",
  screenGeneration: 3,
  controlLeaseId: "lease-1",
  kind: "fake",
  state: "running",
  scope: "team",
  controlHolder: "none",
  homeRevision: "revision-1",
};

describe("toComputerStatus", () => {
  it("only marks control that is bound to a waiting run as a requested takeover", () => {
    const computer = {
      ...baseComputer,
      controlHolder: "user",
      controlBotId: "bot-1",
      controlRunId: "run-1",
    };

    expect(toComputerStatus("bot-1", 5, computer).takeoverRequested).toBe(true);
    expect(
      toComputerStatus("bot-1", 5, { ...computer, controlRunId: null }).takeoverRequested,
    ).toBe(false);
  });

  it("passes through the busy bot name when takeover is blocked", () => {
    expect(toComputerStatus("bot-1", 5, baseComputer).busyBotName).toBeNull();
    expect(toComputerStatus("bot-1", 5, baseComputer, "Writer").busyBotName).toBe("Writer");
  });

  it("hides update on desktop computers", () => {
    expect(toComputerStatus("bot-1", 5, { ...baseComputer, kind: "desktop" }).canUpdate).toBe(
      false,
    );
    expect(toComputerStatus("bot-1", 5, { ...baseComputer, kind: "e2b" }).canUpdate).toBe(true);
  });

  describe("screenStamp", () => {
    const stamp = (botGeneration: number, computer: Partial<typeof baseComputer> = {}) =>
      toComputerStatus("bot-1", botGeneration, { ...baseComputer, ...computer }).screenStamp;

    it("is a 16 character digest of the capability scope", () => {
      expect(stamp(5)).toBe("6370fbd9411db70d");
      expect(stamp(5, { controlLeaseId: null })).toBe("75b0cde08020fbd0");
    });

    it("changes with each input of the sealed scope", () => {
      const base = stamp(5);
      expect(stamp(6)).not.toBe(base);
      expect(stamp(5, { id: "computer-2" })).not.toBe(base);
      expect(stamp(5, { screenGeneration: 4 })).not.toBe(base);
      expect(stamp(5, { controlLeaseId: "lease-2" })).not.toBe(base);
    });

    it("stays equal when only unrelated fields change", () => {
      expect(
        stamp(5, { state: "suspended", homeRevision: "revision-2", controlHolder: "user" }),
      ).toBe(stamp(5));
    });

    it("never exposes the raw ids", () => {
      expect(stamp(5)).not.toContain("computer-1");
      expect(stamp(5)).not.toContain("lease-1");
    });

    it("is empty without a computer", () => {
      expect(toComputerStatus("bot-1", 5, null).screenStamp).toBe("");
    });
  });
});

describe("executionBlocksUserTakeover", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("allows takeover when there is no execution lease", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: false,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
      }),
    ).toBe(false);
  });

  it("allows takeover while the run is waiting for the user", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "waiting_takeover",
        now,
      }),
    ).toBe(false);
  });

  it("allows takeover while the waiting run continues for a chat message", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
        takeoverRequested: true,
      }),
    ).toBe(false);
  });

  it("blocks takeover for an active lease or active run", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
      }),
    ).toBe(true);
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "running",
        now,
      }),
    ).toBe(true);
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "completed",
        now,
      }),
    ).toBe(true);
  });

  it("allows takeover when both the lease and run are inactive", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "completed",
        now,
      }),
    ).toBe(false);
  });
});
