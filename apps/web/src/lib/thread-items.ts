import type { SessionId, ThreadItem } from "@tangow/contracts";
import type { ArtifactTarget } from "./artifact-open";

export type ItemOf<K extends ThreadItem["kind"]> = Extract<ThreadItem, { kind: K }>;
export type MessageItem = ItemOf<"message">;

/** Where a card's answer goes, bound when the card shows: switching threads never redirects it. */
export type CardAnswerTarget = { thread: ArtifactTarget; runId: string; messageId: string };

export type SessionViewTarget =
  | { kind: "session"; sessionId: SessionId; title: string }
  | { kind: "run"; runId: string; title: string };

export function botIdOf(item: MessageItem): string | undefined {
  return item.role === "bot" ? item.botId : undefined;
}

export function isLiveItem(item: ThreadItem): boolean {
  return item.kind === "message" && item.role === "bot" && item.live === true;
}
