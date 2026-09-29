import { describe, expect, it } from "vitest";
import {
  continueRunClaimFence,
  refreshTakeoverContinuePlan,
  takeoverContinuePlan,
  takeoverResumeFromRelease,
  takeoverResumePromptNote,
} from "./takeover-resume.js";

describe("takeoverResumeFromRelease", () => {
  it("maps I'm done and a plain release to a finished takeover", () => {
    for (const reason of ["done", "released", undefined]) {
      expect(takeoverResumeFromRelease(reason)).toEqual({
        checkpoint: "takeover",
        outcome: "done",
      });
    }
  });

  it("keeps skipped and expired apart", () => {
    expect(takeoverResumeFromRelease("skipped")).toEqual({
      checkpoint: "takeover-skipped",
      outcome: "skipped",
    });
    expect(takeoverResumeFromRelease("expired")).toEqual({
      checkpoint: "takeover-expired",
      outcome: "expired",
    });
  });
});

describe("takeoverResumePromptNote", () => {
  it("always tells the bot to observe and not to request takeover again", () => {
    for (const outcome of ["done", "skipped", "expired"] as const) {
      const note = takeoverResumePromptNote(outcome, "Enter the code");
      expect(note).toMatch(/observe/i);
      expect(note).toContain("Do not request takeover again");
    }
  });

  it("quotes the reason when known and omits the clause otherwise", () => {
    expect(takeoverResumePromptNote("done", "Enter the code")).toContain(
      'because: "Enter the code"',
    );
    expect(takeoverResumePromptNote("done")).not.toContain("because");
  });

  it("words each outcome differently", () => {
    expect(takeoverResumePromptNote("done")).toContain("I'm done");
    expect(takeoverResumePromptNote("skipped")).toContain("treat the step as not done");
    expect(takeoverResumePromptNote("expired")).toContain("ask the user whether they finished");
  });
});

describe("takeoverContinuePlan", () => {
  it("keeps a waiting takeover held without treating login as finished", () => {
    const plan = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    expect(plan.heldForTakeover).toBe(true);
    expect(plan.resumeHeldLease).toBe(true);
    expect(plan.resumeCheckpoint).toBeNull();
    expect(plan.takeoverResume).toBeNull();
  });

  it("resumes after a finished or skipped takeover from the release checkpoint", () => {
    const done = takeoverContinuePlan({ status: "queued", checkpoint: "takeover" });
    expect(done.heldForTakeover).toBe(false);
    expect(done.resumeHeldLease).toBe(true);
    expect(done.takeoverResume?.checkpoint).toBe("takeover");

    const skipped = takeoverContinuePlan({
      status: "queued",
      checkpoint: "takeover-skipped",
    });
    expect(skipped.heldForTakeover).toBe(false);
    expect(skipped.takeoverResume?.checkpoint).toBe("takeover-skipped");

    const expired = takeoverContinuePlan({
      status: "queued",
      checkpoint: "takeover-expired",
    });
    expect(expired.resumeHeldLease).toBe(true);
    expect(expired.takeoverResume?.outcome).toBe("expired");
  });

  it("does not treat a normal continue as a takeover resume", () => {
    expect(takeoverContinuePlan({ status: "queued", checkpoint: null })).toEqual({
      resumeCheckpoint: null,
      heldForTakeover: false,
      resumeHeldLease: false,
      takeoverResume: null,
    });
  });
});

describe("continueRunClaimFence", () => {
  it("pins the claim to the observed status and checkpoint", () => {
    expect(continueRunClaimFence({ status: "waiting_takeover", checkpoint: null })).toEqual({
      status: "waiting_takeover",
      checkpoint: null,
    });
    expect(continueRunClaimFence({ status: "queued", checkpoint: "takeover" })).toEqual({
      status: "queued",
      checkpoint: "takeover",
    });
  });
});

describe("refreshTakeoverContinuePlan", () => {
  it("ends the held gate when release stamps a checkpoint on the running run", () => {
    const held = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    const released = refreshTakeoverContinuePlan(held, {
      status: "running",
      checkpoint: "takeover",
    });
    expect(released.heldForTakeover).toBe(false);
    expect(released.resumeCheckpoint).toBe("takeover");
    expect(released.takeoverResume?.checkpoint).toBe("takeover");
  });

  it("keeps the hold when no release checkpoint is present", () => {
    const held = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    expect(refreshTakeoverContinuePlan(held, { status: "running", checkpoint: null })).toBe(held);
  });
});
