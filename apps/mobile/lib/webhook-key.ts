import { rpc } from "./api";
import { readBotPage } from "./bot-page";
import { botRecords } from "./bot-page-state";

/** The bot's webhook key, created on the first read and never replaced by one; the bot record learns it has one. */
export async function readWebhookKey(botId: string): Promise<string> {
  const { secret } = await rpc<{ secret: string }>("bots/webhookSecret", { botId });
  if (!botRecords.bot(botId)?.webhookConfigured) void readBotPage(botId).catch(() => undefined);
  return secret;
}

/** Replaces the bot's webhook key and returns the new one; the old one stops working at once. */
export async function rotateWebhookKey(botId: string): Promise<string> {
  // Without `ifAbsent` the server always stores a new key, so `secret` is never null here.
  const { secret } = await rpc<{ secret: string | null }>("bots/rotateWebhookSecret", { botId });
  if (secret === null) throw new Error("rotateWebhookSecret answered without a key");
  return secret;
}
