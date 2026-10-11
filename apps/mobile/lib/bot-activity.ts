import type { RunActivityRow, RunFailureKind } from "@rakazo/contracts";
import { t } from "./i18n";

export type StateWord = "done" | "failed" | "cancelled" | "running" | "waiting";

export function stateWord(word: StateWord): string {
  switch (word) {
    case "done":
      return t("Done");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
    case "running":
      return t("Running");
    case "waiting":
      return t("Waiting");
  }
}

/** Why a run failed, in a few words, when the server knows. */
export function failureReason(kind: RunFailureKind | null): string | null {
  if (kind === "missing_model") return t("No model connected");
  if (kind === "computer") return t("Computer unavailable");
  if (kind === "provider") return t("Model error");
  return null;
}

/** Where a run opens: its bot's thread or its group, at `sourceMessageId` when there is one. */
export function runDestination(
  row: Pick<RunActivityRow, "botId" | "botName" | "groupId" | "groupName" | "sourceMessageId">,
):
  | { pathname: "/thread"; params: { botId: string; name: string; messageId?: string } }
  | { pathname: "/group-thread"; params: { groupId: string; name: string; messageId?: string } } {
  const at = row.sourceMessageId ? { messageId: row.sourceMessageId } : {};
  return row.groupId
    ? {
        pathname: "/group-thread",
        params: { groupId: row.groupId, name: row.groupName ?? "", ...at },
      }
    : { pathname: "/thread", params: { botId: row.botId, name: row.botName, ...at } };
}
