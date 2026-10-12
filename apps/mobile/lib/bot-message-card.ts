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
              ...(item.direction === "received" && item.origin
                ? { messageId: item.origin.entryId }
                : {}),
            },
          }
        : null,
  };
}
