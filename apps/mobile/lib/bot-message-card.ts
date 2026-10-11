import type { BotMessageIntent, ThreadItem } from "@rakazo/contracts";
import { t } from "./i18n";

type BotMessageItem = Extract<ThreadItem, { kind: "botMessage" }>;

function intentWord(intent: BotMessageIntent): string {
  switch (intent) {
    case "request":
      return t("Request");
    case "result":
      return t("Result");
    case "question":
      return t("Question");
    case "status":
      return t("Status");
    case "fyi":
      return t("FYI");
  }
}

/**
 * What a bot-to-bot card says, split around the peer's name so the name can be a link, and the
 * thread that link opens: the sender's at the linked entry for a received message, the peer's for
 * a sent one, none for another owner's agent.
 */
export function botMessageCard(item: BotMessageItem) {
  const template = item.direction === "sent" ? t("Messaged {peer}") : t("Message from {peer}");
  const [before = "", after = ""] = template.split("{peer}");
  const intent = intentWord(item.intent);
  const peer = item.peer.name;
  return {
    before,
    peer,
    after: `${after} · ${intent}`,
    label: `${before}${peer}${after} · ${intent}`,
    muted: item.direction === "sent" && item.answeredBy === null,
    peerThread:
      item.peer.kind === "bot"
        ? {
            pathname: "/thread" as const,
            params: {
              botId: item.peer.botId,
              name: peer,
              ...(item.direction === "received" ? { messageId: item.origin.entryId } : {}),
            },
          }
        : null,
  };
}
