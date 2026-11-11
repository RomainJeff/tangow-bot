import type { MessageBlock } from "@tangow/contracts";
import { t } from "./i18n";

export type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

export function appConnectPresentation(block: AppConnectBlock, busy = false) {
  const connected = block.status === "connected";
  // An MCP server a shared bot needs is added with the person's own credentials in the MCP server
  // form, which only web and desktop have: mobile says where, instead of a dead card.
  const mcp = block.connectorId === "mcp";
  return {
    title: block.name,
    description: block.description,
    showAuthorize: !connected && !mcp,
    actionLabel: connected ? t("Connected") : busy ? t("Waiting…") : t("Authorize"),
    hint: mcp && !connected ? t("Add it on web or desktop") : null,
    connected,
  };
}
