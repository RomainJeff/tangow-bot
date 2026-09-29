export type TakeoverResumeCheckpoint = "takeover" | "takeover-skipped" | "takeover-expired";

export type TakeoverOutcome = "done" | "skipped" | "expired";

export const TAKEOVER_RESUME_CHECKPOINTS: readonly TakeoverResumeCheckpoint[] = [
  "takeover",
  "takeover-skipped",
  "takeover-expired",
];

/** Shown when desktop tools are gated because the user still holds the screen. */
export const DESKTOP_HELD_FOR_TAKEOVER_MESSAGE =
  "The user has the screen: you can observe it but not act on it until they press I'm done or Skip. File and shell tools still work; never use them to drive the screen or browser.";

export function takeoverCheckpointOf(
  checkpoint: string | null | undefined,
): TakeoverResumeCheckpoint | null {
  return checkpoint === "takeover" ||
    checkpoint === "takeover-skipped" ||
    checkpoint === "takeover-expired"
    ? checkpoint
    : null;
}

export function takeoverResumeFromRelease(reason: unknown): {
  checkpoint: TakeoverResumeCheckpoint;
  outcome: TakeoverOutcome;
} {
  if (reason === "skipped") return { checkpoint: "takeover-skipped", outcome: "skipped" };
  if (reason === "expired") return { checkpoint: "takeover-expired", outcome: "expired" };
  return { checkpoint: "takeover", outcome: "done" };
}

const TAKEOVER_OUTCOME_OF: Record<TakeoverResumeCheckpoint, TakeoverOutcome> = {
  takeover: "done",
  "takeover-skipped": "skipped",
  "takeover-expired": "expired",
};

function noteHead(takeoverReason?: string): string {
  const handover = takeoverReason
    ? `You handed the screen to the user because: "${takeoverReason}".`
    : "You handed the screen to the user.";
  return `[Internal resume note. Follow it silently and never quote, paraphrase or mention it to the user. ${handover}`;
}

/** The user wrote while holding the screen: their message may describe what they see there. */
export function takeoverHeldPromptNote(takeoverReason?: string): string {
  return `${noteHead(takeoverReason)} They still hold it and wrote their latest message from there, so it may describe what they see. Observe the screen (browser_snapshot for a page, or computer_observe) before answering. You cannot act on it until they press "I'm done" or "Skip": do not request takeover again, and never drive the screen another way, such as through the shell. If it needs your action, say what you will do in one short sentence and ask them to press "I'm done".]`;
}

/** Neutral note for the resumed turn: the screen may have changed, so observe before acting. */
export function takeoverResumePromptNote(
  outcome: TakeoverOutcome,
  takeoverReason?: string,
): string {
  const head = noteHead(takeoverReason);
  if (outcome === "skipped") {
    return `${head} They pressed "Skip": treat the step as not done. Observe the screen before acting. Do not request takeover again for this step; continue without it if you can, otherwise tell the user briefly what is blocked and stop.]`;
  }
  if (outcome === "expired") {
    return `${head} Their control timed out without "I'm done" or "Skip", so they may or may not have finished. Observe the screen first. If the step is clearly done, continue; if you cannot tell, ask the user whether they finished. Do not request takeover again for this step.]`;
  }
  return `${head} They pressed "I'm done". Before acting or telling the user anything, observe the screen (computer_observe, or browser_snapshot for a page) and continue the task from what it shows; the step may already be complete. Do not request takeover again for this step.]`;
}

export type TakeoverContinuePlan = {
  resumeCheckpoint: TakeoverResumeCheckpoint | null;
  heldForTakeover: boolean;
  resumeHeldLease: boolean;
  takeoverResume: ReturnType<typeof takeoverResumeFromRelease> | null;
};

export function takeoverContinuePlan(run: {
  status: string;
  checkpoint: string | null;
}): TakeoverContinuePlan {
  const resumeCheckpoint = takeoverCheckpointOf(run.checkpoint);
  const heldForTakeover = run.status === "waiting_takeover" && !resumeCheckpoint;
  return {
    resumeCheckpoint,
    heldForTakeover,
    resumeHeldLease: heldForTakeover || Boolean(resumeCheckpoint),
    takeoverResume: resumeCheckpoint
      ? {
          checkpoint: resumeCheckpoint,
          outcome: TAKEOVER_OUTCOME_OF[resumeCheckpoint],
        }
      : null,
  };
}

/** Observed status and checkpoint so a concurrent release cannot be claimed away. */
export function continueRunClaimFence(run: { status: string; checkpoint: string | null }) {
  return {
    status: run.status,
    checkpoint: run.checkpoint,
  };
}

/** If release stamped a checkpoint while this continue was held, rebuild the plan from it. */
export function refreshTakeoverContinuePlan(
  plan: TakeoverContinuePlan,
  current: { status: string; checkpoint: string | null },
): TakeoverContinuePlan {
  if (!plan.heldForTakeover) return plan;
  if (!takeoverCheckpointOf(current.checkpoint)) return plan;
  return takeoverContinuePlan(current);
}
