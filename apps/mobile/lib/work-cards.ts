import type { PendingWorkAsk } from "@rakazo/contracts";
import type { TaskLineState } from "@rakazo/core";
import { taskStateTone } from "@rakazo/core";
import type { ColorTokens } from "@rakazo/ui-tokens";
import { t } from "./i18n";

/** A state as a native symbol: SF Symbols on iOS, Ionicons elsewhere. */
export type StateGlyph = {
  ios: string;
  android: "checkmark" | "close" | "ban-outline" | "remove" | "ellipse-outline" | "ellipse";
};

const STATE_GLYPHS: Record<TaskLineState, StateGlyph> = {
  // Still working: a ring. Waiting on an answer: the same dot, filled.
  running: { ios: "circle", android: "ellipse-outline" },
  waiting: { ios: "circle.fill", android: "ellipse" },
  done: { ios: "checkmark", android: "checkmark" },
  failed: { ios: "xmark", android: "close" },
  cancelled: { ios: "slash.circle", android: "ban-outline" },
  no_result: { ios: "minus", android: "remove" },
  closed: { ios: "checkmark", android: "checkmark" },
};

export function workStateGlyph(state: TaskLineState): StateGlyph {
  return STATE_GLYPHS[state];
}

/** The tint of a state's glyph; the label always says it in words too. */
export function workStateColor(state: TaskLineState, tokens: ColorTokens): string {
  switch (taskStateTone(state)) {
    case "success":
      return tokens.success;
    case "destructive":
      return tokens.destructive;
    case "muted":
      return tokens.mutedForeground;
    default:
      return tokens.foreground;
  }
}

/** A state in words; waiting reuses the approval card's own "needs your call". */
export function workStateLabel(state: TaskLineState): string {
  switch (state) {
    case "running":
      return t("Running");
    case "waiting":
      return t("Needs your call");
    case "done":
      return t("Done");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
    case "no_result":
      return t("No result");
    case "closed":
      return t("Closed");
  }
}

/** The delegated asks the coordinator thread can show: a pending work without an ask has no card. */
export function answerableWorkAsks(
  pendingWork: readonly PendingWorkAsk[] | undefined,
): PendingWorkAsk[] {
  return (pendingWork ?? []).filter((work) =>
    work.message.blocks.some((block) => block.kind === "ask"),
  );
}
