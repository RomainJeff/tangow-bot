import type { AdapterContext, ConnectorCall, ConnectorProvider } from "@rakazo/adapter-kit";
import type { AskDraftConversation } from "@rakazo/contracts";
import { LINE_BREAKS } from "@rakazo/core";
import { isComposioBatch } from "./connector-actions.js";
import { findInResult, isRecord, readConnector, remember } from "./connector-read.js";

/** Chat apps whose recipients a draft card can name: a send of any other keeps today's gate. */
export const CHAT_APPS: ReadonlySet<string> = new Set(["slack"]);

/** How long each Slack read may take before the send falls back to the classic card. */
const TIMEOUT_MS = 1_500;
const TTL_MS = 10 * 60_000;
const NAME_MAX_LENGTH = 200;
const USER_ID = /^[UW][A-Z0-9]+$/;
const CONVERSATION_ID = /^[CDG][A-Z0-9]+$/;
// Composio passes Slack's answer on under `data`, inside a batch per action under `results`.
const ANSWER_WALK = {
  keys: ["data", "structuredContent", "content", "results", "response"],
  depth: 8,
};
/** Slack's own MCP server, known by where it is reached, never by the name a user gave it. */
const SLACK_MCP_HOST = "mcp.slack.com";

type Person = Extract<AskDraftConversation, { kind: "person" }>;
/** A conversation as a read names it: a channel's name, or the person a direct message is with. */
type Channel = { name?: string; im?: string };
type Read = { tool: string; args: Record<string, unknown> };

/**
 * How a server that sends Slack messages names who they go to: the read that names a person and
 * the one that names a conversation, each with what to take from its answer, for that id only.
 */
type SlackReads = {
  person: (id: string) => Read;
  personIn: (record: Record<string, unknown>, id: string) => Person | undefined;
  channel: (id: string) => Read;
  channelIn: (record: Record<string, unknown>, id: string) => Channel | undefined;
};

const SLACK_READS = {
  // Composio's Slack reads (toolkit 2026-10) pass on Slack's users.info and conversations.info.
  composio: {
    person: (user) => ({ tool: "SLACK_RETRIEVE_DETAILED_USER_INFORMATION", args: { user } }),
    personIn: (record, id) => {
      const user = record.user;
      if (!isRecord(user) || user.id !== id) return undefined;
      const profile = isRecord(user.profile) ? user.profile : {};
      return person(clean(profile.real_name) || clean(user.real_name), [
        clean(profile.display_name),
        clean(user.name),
      ]);
    },
    channel: (channel) => ({ tool: "SLACK_RETRIEVE_CONVERSATION_INFORMATION", args: { channel } }),
    channelIn: (record, id) => {
      const channel = record.channel;
      if (!isRecord(channel) || channel.id !== id) return undefined;
      if (channel.is_im === true && typeof channel.user === "string") return { im: channel.user };
      return channel.is_mpim === true ? {} : { name: clean(channel.name) };
    },
  },
  // Slack's MCP server answers in lines: a profile opens on its user id, a channel's history on
  // the channel's name and id, ahead of any message.
  slackMcp: {
    person: (user_id) => ({
      tool: "slack_read_user_profile",
      args: { user_id, response_format: "detailed" },
    }),
    personIn: (record, id) => {
      const lines = textOf(record, "result")?.split("\n") ?? [];
      if (lines[0] !== `User ID: ${id}`) return undefined;
      const field = (key: string) =>
        clean(lines.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2));
      return person(field("Real Name"), [field("Display Name"), field("Username")]);
    },
    channel: (channel_id) => ({
      tool: "slack_read_channel",
      args: { channel_id, limit: 1, response_format: "concise" },
    }),
    channelIn: (record, id) => {
      const header = textOf(record, "messages")?.split("\n", 1)[0];
      const named = header?.match(/^Channel: #(\S+) \(([A-Z0-9]+)\)$/);
      if (named?.[2] !== id) return undefined;
      // A group message is neither a person nor a channel the card can name.
      return named[1]!.startsWith("mpdm-") ? {} : { name: clean(named[1]) };
    },
  },
} satisfies Record<string, SlackReads>;

export type SlackServer = keyof typeof SLACK_READS;

/**
 * Which Slack server a send goes through: Composio, natively or through its batch tool behind any
 * MCP server, or Slack's own MCP server by its endpoint. Undefined for any other.
 */
export function slackServer(call: ConnectorCall, mcpEndpoint?: string): SlackServer | undefined {
  if (isComposioBatch(call.route?.toolName ?? call.tool)) return "composio";
  if (call.route?.connectorId === "composio") return "composio";
  if (call.route?.connectorId !== "mcp" || !mcpEndpoint) return undefined;
  try {
    return new URL(mcpEndpoint).hostname === SLACK_MCP_HOST ? "slackMcp" : undefined;
  } catch {
    return undefined;
  }
}

/** Recipients Slack already named, by who asked, through which connection, and the id. */
export type ChatRecipientCache = Map<string, { at: number; conversation: AskDraftConversation }>;

/**
 * Who a Slack message goes to, as Slack names them, read through the send's own server, route and
 * connection: a person for a user id or a direct message, a channel for a channel. Undefined for a
 * server this does not know, or when Slack does not answer in time or names nothing the card can
 * show; never a name from the bot.
 */
export async function lookUpChatRecipient(
  connector: Pick<ConnectorProvider, "execute">,
  call: ConnectorCall,
  server: SlackServer | undefined,
  id: string,
  context: AdapterContext,
  cache: ChatRecipientCache,
): Promise<AskDraftConversation | undefined> {
  if (!server) return undefined;
  const reads: SlackReads = SLACK_READS[server];
  const { route } = call;
  const key = [
    context.spaceId,
    context.userId,
    context.botId,
    route?.connectorId,
    route?.resourceId,
    route?.resourceRevision,
    call.connectionId,
    batchItem(call)?.account,
    id,
  ].join("\0");
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.conversation;
  const read = async <T>(
    { tool, args }: Read,
    pick: (record: Record<string, unknown>) => T | undefined,
  ) => {
    if (context.signal.aborted) return undefined;
    const data = await readConnector(connector, readCall(call, tool, args), context, TIMEOUT_MS);
    // An MCP server reports a failed call as a result: nothing in it names anyone.
    if (isRecord(data) && data.isError === true) return undefined;
    return findInResult(data, pick, ANSWER_WALK);
  };
  const named = async (user: string) =>
    USER_ID.test(user)
      ? read(reads.person(user), (record) => reads.personIn(record, user))
      : undefined;
  let conversation: AskDraftConversation | undefined;
  if (USER_ID.test(id)) conversation = await named(id);
  else if (CONVERSATION_ID.test(id)) {
    const channel = await read(reads.channel(id), (record) => reads.channelIn(record, id));
    if (channel?.im) conversation = await named(channel.im);
    else if (channel?.name) conversation = { kind: "channel", name: channel.name };
  }
  if (conversation) remember(cache, key, { at: Date.now(), conversation });
  return conversation;
}

/**
 * A person as a draft names them: their full name, and the first handle they go by that adds
 * something, since many people set their display name to their full name.
 */
function person(name: string, handles: string[]): Person | undefined {
  const handle = handles.find((each) => each && each.toLowerCase() !== name.toLowerCase());
  if (!name && !handle) return undefined;
  return name
    ? { kind: "person", name, ...(handle ? { handle } : {}) }
    : { kind: "person", name: handle! };
}

function textOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(LINE_BREAKS, " ").trim().slice(0, NAME_MAX_LENGTH)
    : "";
}

/**
 * The read `tool` made the way the send is: through Composio's batch with the send's account, or
 * direct. It is built whole here: nothing else the bot wrote in its send travels with it.
 */
function readCall(call: ConnectorCall, tool: string, args: Record<string, unknown>): ConnectorCall {
  const executionId = `${call.executionId}:recipient`;
  const item = batchItem(call);
  if (item) {
    const account = typeof item.account === "string" ? { account: item.account } : {};
    return {
      tool: call.route?.toolName ?? call.tool,
      args: { tools: [{ tool_slug: tool, ...account, arguments: args }] },
      executionId,
      ...(call.connectionId ? { connectionId: call.connectionId } : {}),
      ...(call.route ? { route: call.route } : {}),
    };
  }
  return {
    tool,
    args,
    executionId,
    ...(call.connectionId ? { connectionId: call.connectionId } : {}),
    ...(call.route ? { route: { ...call.route, toolName: tool } } : {}),
  };
}

function batchItem(call: ConnectorCall): Record<string, unknown> | undefined {
  if (!isComposioBatch(call.route?.toolName ?? call.tool)) return undefined;
  const [item] = Array.isArray(call.args.tools) ? call.args.tools : [];
  return isRecord(item) ? item : undefined;
}
