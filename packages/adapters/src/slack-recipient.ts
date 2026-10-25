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
// Composio passes Slack's answer on under `data`, inside a batch per action under `results`.
const ANSWER_WALK = {
  keys: ["data", "structuredContent", "content", "results", "response"],
  depth: 8,
};
// Composio's Slack reads (toolkit 2026-10): conversations.info and users.info.
const CONVERSATION_TOOL = "SLACK_RETRIEVE_CONVERSATION_INFORMATION";
const USER_TOOL = "SLACK_RETRIEVE_DETAILED_USER_INFORMATION";
const USER_ID = /^[UW][A-Z0-9]+$/;
const CONVERSATION_ID = /^[CDG][A-Z0-9]+$/;

/** Recipients Slack already named, by who asked, through which connection, and the id. */
export type ChatRecipientCache = Map<string, { at: number; conversation: AskDraftConversation }>;

/**
 * Who a Slack message goes to, as Slack names them, read through the send's own route and
 * connection: a person for a user id or a direct message, a channel for a channel. Undefined when
 * Slack does not answer in time or names nothing the card can show; never a name from the bot.
 */
export async function lookUpChatRecipient(
  connector: Pick<ConnectorProvider, "execute">,
  call: ConnectorCall,
  id: string,
  context: AdapterContext,
  cache: ChatRecipientCache,
): Promise<AskDraftConversation | undefined> {
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
  const read = async (tool: string, args: Record<string, string>, field: string) => {
    if (context.signal.aborted) return undefined;
    const data = await readConnector(connector, readCall(call, tool, args), context, TIMEOUT_MS);
    const value = args[field];
    return findInResult(
      data,
      (record) => {
        const found = record[field];
        return isRecord(found) && found.id === value ? found : undefined;
      },
      ANSWER_WALK,
    );
  };
  const person = async (user: string) => {
    const found = USER_ID.test(user) ? await read(USER_TOOL, { user }, "user") : undefined;
    return found && personIn(found);
  };
  let conversation: AskDraftConversation | undefined;
  if (USER_ID.test(id)) conversation = await person(id);
  else if (CONVERSATION_ID.test(id)) {
    const channel = await read(CONVERSATION_TOOL, { channel: id }, "channel");
    if (channel?.is_im === true && typeof channel.user === "string") {
      conversation = await person(channel.user);
    } else if (channel && channel.is_mpim !== true && typeof channel.name === "string") {
      const name = clean(channel.name);
      if (name) conversation = { kind: "channel", name };
    }
  }
  if (conversation) remember(cache, key, { at: Date.now(), conversation });
  return conversation;
}

/** A Slack user as a draft names them: their full name, and the handle they go by. */
function personIn(user: Record<string, unknown>): AskDraftConversation | undefined {
  const profile = isRecord(user.profile) ? user.profile : {};
  const name = clean(profile.real_name) || clean(user.real_name);
  // Many people set their display name to their full name: the handle then adds nothing.
  const handle = [clean(profile.display_name), clean(user.name)].find(
    (each) => each && each.toLowerCase() !== name.toLowerCase(),
  );
  if (!name && !handle) return undefined;
  return name
    ? { kind: "person", name, ...(handle ? { handle } : {}) }
    : { kind: "person", name: handle! };
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
function readCall(call: ConnectorCall, tool: string, args: Record<string, string>): ConnectorCall {
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
