import type { MessageBlock } from "@rakazo/contracts";

export type RoutinePreview = { name: string; schedule: string; prompt: string; notify: boolean };

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/**
 * A routine card: `detail` repeats the preview as plain text for a client that does not know
 * `routine`.
 */
function routineAsk(effectId: string, routine: RoutinePreview, text: string): AskBlock {
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text,
    detail: [
      `name: ${routine.name}`,
      `schedule: ${routine.schedule}`,
      `notify: ${routine.notify ? "yes" : "no"}`,
      "prompt:",
      indent(routine.prompt),
    ].join("\n"),
    status: "pending",
    actions: [
      { id: "allow", label: "Create routine", outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
    routine,
  };
}

export type CreatedRoutine = RoutinePreview & { id: string };

/** A routine card once its routine exists: it opens on when the routine runs and links to it. */
function settledOn({
  id,
  ...preview
}: CreatedRoutine): Pick<AskBlock, "text" | "routine" | "created"> {
  return {
    text: preview.schedule,
    routine: preview,
    created: { kind: "routine", id, label: preview.name },
  };
}

/** A routine the user asked for, set up or changed: its card already settled, with nothing to answer. */
export function routineConfirmationBlock(
  effectId: string,
  routine: CreatedRoutine,
  change: "created" | "updated",
): AskBlock {
  return {
    ...routineAsk(effectId, routine, routine.schedule),
    status: "answered",
    ...settledOn(routine),
    confirms: change,
  };
}

/** The approval card the user allowed for a routine, settled on the routine it created. */
export function settleRoutineAsk(card: AskBlock, routine: CreatedRoutine): AskBlock {
  return { ...card, ...settledOn(routine) };
}
