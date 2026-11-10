import type { MessageBlock } from "@rakazo/contracts";
import { t } from "./i18n";

export type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

export function appConnectPresentation(block: AppConnectBlock, busy = false) {
  const connected = block.status === "connected";
  return {
    title: block.name,
    description: block.description,
    // An MCP server a shared bot needs is added from the web app, with its form.
    showAuthorize: !connected && block.connectorId !== "mcp",
    actionLabel: connected ? t("Connected") : busy ? t("Waiting…") : t("Authorize"),
    connected,
  };
}
