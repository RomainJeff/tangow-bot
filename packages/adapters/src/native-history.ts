import type { AgentRunRequest } from "@rakazo/adapter-kit";
import {
  ASSISTANT_TURN_CLOSE,
  ASSISTANT_TURN_OPEN,
  sealAssistantTurnMarkers,
  stripFakeToolCalls,
  withoutCurrentPrompt,
} from "./pi-runtime.js";

const HISTORY_OPEN = "<conversation_history>";
const HISTORY_CLOSE = "</conversation_history>";

const sealHistory = (content: string) =>
  sealAssistantTurnMarkers(content)
    .replaceAll(HISTORY_OPEN, "&lt;conversation_history&gt;")
    .replaceAll(HISTORY_CLOSE, "&lt;/conversation_history&gt;");

/**
 * A native session that starts without native continuity knows nothing of the thread, so its
 * first turn carries the same Rakazo history the default runtime receives (already compacted
 * and windowed by the executor). Native tools cannot replay Rakazo tool turns; each turn
 * contributes its text rendering. A thread with no earlier turn sends the prompt unchanged.
 */
export function promptWithThreadHistory(
  request: Pick<AgentRunRequest, "prompt" | "history" | "sourceMessageId">,
): string {
  const turns = withoutCurrentPrompt(
    request.history,
    request.prompt,
    request.sourceMessageId,
  ).filter((turn) => turn.role !== "system" && turn.content.trim() !== "");
  if (turns.length === 0) return request.prompt;
  const rendered = turns.map((turn) =>
    turn.role === "assistant"
      ? `${ASSISTANT_TURN_OPEN}\n${sealHistory(stripFakeToolCalls(turn.content))}\n${ASSISTANT_TURN_CLOSE}`
      : sealHistory(turn.content),
  );
  return [
    "This conversation is continuing in a new session. The earlier turns, oldest first, are context only; answer the message after them.",
    HISTORY_OPEN,
    rendered.join("\n\n"),
    HISTORY_CLOSE,
    "",
    request.prompt,
  ].join("\n");
}
