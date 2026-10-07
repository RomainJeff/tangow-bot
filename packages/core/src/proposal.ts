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

/**
 * What the user sees once a routine they asked for is set up: the routine card already settled,
 * linking to the routine, with nothing to answer. It opens on when the routine runs.
 */
export function routineConfirmationBlock(
  effectId: string,
  routine: RoutinePreview & { id: string },
): AskBlock {
  const { id, ...preview } = routine;
  return {
    ...routineAsk(effectId, preview, preview.schedule),
    status: "answered",
    created: { kind: "routine", id, label: preview.name },
    confirms: "created",
  };
}
