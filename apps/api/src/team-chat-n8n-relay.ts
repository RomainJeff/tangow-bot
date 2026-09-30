import { timingSafeEqual } from "node:crypto";
import type { TeamChatInboundMessage, TeamChatMessageKind } from "@rakazo/adapter-kit";
import type { Hono } from "hono";
import type { TeamChatBridge } from "./team-chat-bridge.js";

export const TEAM_CHAT_N8N_RELAY_PATH = "/api/v1/team-chat/relay/n8n";

export type N8nRelayMessage = {
  provider: "slack";
  relaySenderId: string;
  workspaceId: string;
  conversationKey: string;
  conversationId: string;
  eventId: string;
  replyThreadId: string | null;
  sender: { id: string; name?: string; isBot?: boolean };
  content: string;
  kind: TeamChatMessageKind;
  channelName?: string;
  participantNames?: string[];
  slackEvent: {
    type: "message" | "app_mention";
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    text: string;
    subtype?: string;
    bot_id?: string;
    bot_profile?: unknown;
  };
};

export function mountTeamChatN8nRelayRoutes(
  app: Hono,
  deps: {
    secret: string | undefined;
    bridge: () => TeamChatBridge | undefined;
    botUserId: string | undefined;
  },
): void {
  app.post(TEAM_CHAT_N8N_RELAY_PATH, async (c) => {
    if (!deps.secret) return c.json({ error: "Team chat relay is disabled" }, 404);
    const raw = await c.req.text();
    if (!verifyN8nRelayBearer(deps.secret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized relay" }, 401);
    const message = parseN8nRelayMessage(raw);
    if (!message || !isConsistentSlackEvent(message, deps.botUserId)) {
      return c.json({ error: "Invalid relay message" }, 400);
    }
    const bridge = deps.bridge();
    if (!bridge) return c.json({ error: "Team chat bridge unavailable" }, 503);
    const inbound = toN8nRelayInbound(message);
    await bridge.receive(inbound);
    return c.json({ accepted: true }, 202);
  });
}

export function verifyN8nRelayBearer(secret: string, authorization: string | undefined): boolean {
  const match = authorization?.match(/^Bearer (.+)$/);
  if (!match) return false;
  const provided = Buffer.from(match[1]!);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function parseN8nRelayMessage(raw: string): N8nRelayMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.provider !== "slack" || !isRecord(value.sender)) return null;
    // Bound once so the record check narrows every later field read, including inside callbacks.
    const event = value.slackEvent;
    if (
      !["ambient", "mention"].includes(value.kind as string) ||
      !isRecord(event) ||
      ![
        "relaySenderId",
        "workspaceId",
        "conversationKey",
        "conversationId",
        "eventId",
        "content",
      ].every((key) => nonEmpty(value[key])) ||
      !nonEmpty(value.sender.id) ||
      value.sender.isBot === true ||
      (value.replyThreadId !== null && !nonEmpty(value.replyThreadId)) ||
      !["message", "app_mention"].includes(event.type as string) ||
      !["user", "channel", "ts", "text"].every((key) => nonEmpty(event[key])) ||
      (event.thread_ts !== undefined && !nonEmpty(event.thread_ts)) ||
      (event.subtype !== undefined && typeof event.subtype !== "string") ||
      (event.bot_id !== undefined && typeof event.bot_id !== "string")
    )
      return null;
    return {
      provider: "slack",
      relaySenderId: value.relaySenderId as string,
      workspaceId: value.workspaceId as string,
      conversationKey: value.conversationKey as string,
      conversationId: value.conversationId as string,
      eventId: value.eventId as string,
      replyThreadId: value.replyThreadId as string | null,
      sender: {
        id: value.sender.id as string,
        ...(typeof value.sender.name === "string" ? { name: value.sender.name } : {}),
      },
      content: value.content as string,
      kind: value.kind as TeamChatMessageKind,
      slackEvent: event as N8nRelayMessage["slackEvent"],
      ...(typeof value.channelName === "string" ? { channelName: value.channelName } : {}),
      ...(Array.isArray(value.participantNames) && value.participantNames.every(nonEmpty)
        ? { participantNames: value.participantNames as string[] }
        : {}),
    };
  } catch {
    return null;
  }
}

export function toN8nRelayInbound(message: N8nRelayMessage): TeamChatInboundMessage {
  return {
    eventId: message.eventId,
    workspaceId: message.workspaceId,
    kind: message.kind,
    conversationType: "channel",
    conversationKey: message.conversationKey,
    conversationId: message.conversationId,
    conversationName: message.channelName,
    participantNames: message.participantNames,
    replyThreadId: message.replyThreadId,
    senderId: message.sender.id,
    senderName: message.sender.name?.trim() || message.sender.id,
    content: message.content,
    relaySenderId: message.relaySenderId,
    relayConversationKey: message.slackEvent.channel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isConsistentSlackEvent(
  message: N8nRelayMessage,
  botUserId: string | undefined,
): boolean {
  const event = message.slackEvent;
  const threadTs = event.thread_ts ?? event.ts;
  if (
    event.user !== message.sender.id ||
    event.ts !== message.eventId ||
    message.conversationKey !== `${event.channel}:${threadTs}` ||
    message.replyThreadId !== threadTs ||
    message.conversationId !== `slack:${event.channel}:${threadTs}`
  )
    return false;
  if (event.subtype !== undefined || event.bot_id || event.bot_profile) return false;
  const mentioned =
    event.type === "app_mention" || (!!botUserId && event.text.includes(`<@${botUserId}>`));
  return message.kind === (mentioned ? "mention" : "ambient") && message.content === event.text;
}
