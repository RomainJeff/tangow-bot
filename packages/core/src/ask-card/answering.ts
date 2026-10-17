import type { ThreadView } from "../session-log/project-thread-view.js";
import { askFormOf } from "./form.js";

/**
 * Whether a send without a mention, which goes to `sendsTo`, answers that bot's pending question.
 * Approvals, secrets and proposals do not count: the server refuses composer text for them. Any
 * other bot waiting on the person makes it ambiguous, so it does not count either.
 */
export function answersPendingQuestion(
  view: Pick<ThreadView, "rows" | "waiting">,
  sendsTo: string,
  runs: readonly { botId?: string; status: string }[],
): boolean {
  const { waiting } = view;
  const item = waiting && view.rows.find((row) => row.item.id === waiting.itemId)?.item;
  if (item?.kind !== "message" || item.role !== "bot" || item.botId !== sendsTo) return false;
  const ask = item.blocks.find((block) => block.kind === "ask" && block.status !== "answered");
  return (
    ask?.kind === "ask" &&
    askFormOf(ask) !== null &&
    runs.every((run) => run.status !== "waiting_input" || run.botId === sendsTo)
  );
}
