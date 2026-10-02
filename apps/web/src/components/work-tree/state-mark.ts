import { t } from "@lingui/core/macro";
import type { TaskLineState, TaskStateTone } from "@rakazo/core";
import { taskStateTone } from "@rakazo/core";

const GLYPHS: Record<TaskLineState, string | null> = {
  // Still working, or waiting for an answer: drawn as a dot, not a glyph.
  running: null,
  waiting: null,
  done: "✓",
  failed: "✕",
  cancelled: "⊘",
  no_result: "–",
  closed: "✓",
};

const TONE_CLASSES: Record<TaskStateTone, string> = {
  success: "text-success",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function stateLabel(state: TaskLineState): string {
  switch (state) {
    case "running":
      return t`Running`;
    case "waiting":
      return t`Needs your call`;
    case "done":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    case "no_result":
      return t`No result`;
    case "closed":
      return t`Closed`;
  }
}

/** The glyph, tone and label a state shows, wherever a task's standing is drawn. */
export function stateMark(state: TaskLineState) {
  const tone = taskStateTone(state);
  return {
    glyph: GLYPHS[state],
    tone: tone ? TONE_CLASSES[tone] : "",
    label: stateLabel(state),
  };
}
