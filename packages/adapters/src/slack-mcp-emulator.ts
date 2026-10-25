import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";

/** The emulated Slack workspace: its people, and the channels and direct messages they share. */
export const EMULATED_SLACK_USERS = [
  { id: "U0MARIE", name: "marie", real_name: "Marie Dupont" },
  { id: "U0BOB", name: "bob", real_name: "Bob Martin" },
];
export const EMULATED_SLACK_CONVERSATIONS: Record<string, Record<string, unknown>> = {
  C0GENERAL: { id: "C0GENERAL", name: "general", is_channel: true },
  C0LAUNCH: { id: "C0LAUNCH", name: "launch", is_channel: true, is_private: true },
  D0MARIE: { id: "D0MARIE", is_im: true, user: "U0MARIE" },
};

const strings = (description: string) => ({ type: "string", description });

/**
 * The tools of Slack's own MCP server (mcp.slack.com) a draft uses, with the inputs its tool list
 * gives (2026-10). It answers in text, a JSON object whose `result` or `messages` reads as lines.
 */
export const SLACK_MCP_TOOLS: ConnectorTool[] = [
  {
    name: "slack_send_message",
    description: "Sends a message to a Slack channel or user.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: strings("Channel, or a user id for a direct message"),
        message: strings("The message, in Markdown"),
        thread_ts: strings("The parent message to reply to"),
        reply_broadcast: { type: "boolean" },
        unfurl_app_links: { type: "boolean" },
        draft_id: strings("A Slack draft to delete once sent"),
      },
      required: ["channel_id", "message"],
    },
  },
  {
    name: "slack_read_user_profile",
    description: "Retrieves detailed profile information for a Slack user.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        user_id: strings("Slack user ID"),
        response_format: { type: "string", enum: ["detailed", "concise"] },
      },
    },
  },
  {
    name: "slack_read_channel",
    description: "Reads messages from a Slack channel, newest first.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: strings("Channel id"),
        limit: { type: "integer" },
        response_format: { type: "string" },
      },
      required: ["channel_id"],
    },
  },
];

type Fault = { kind: "fail"; error: string } | { kind: "hang" };

/** Deterministic, offline stand-in for Slack's MCP server, answering the way it does. */
export class SlackMcpEmulator {
  private readonly faults = new Map<string, Fault>();
  readonly executions: Array<{ tool: string; args: Record<string, unknown> }> = [];

  /** Test helper: the next call of `tool` returns an MCP tool error, or never answers. */
  failNext(tool: string, fault: Fault): void {
    this.faults.set(tool, fault);
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const tool = call.route?.toolName ?? call.tool;
    const fault = this.faults.get(tool);
    this.faults.delete(tool);
    if (fault?.kind === "hang") {
      if (!context.signal.aborted) {
        await new Promise((resolve) => context.signal.addEventListener("abort", resolve));
      }
      yield { type: "error", message: `${tool} was cancelled` };
      return;
    }
    this.executions.push({ tool, args: call.args });
    const answer = fault ? { error: fault.error } : this.answer(tool, call.args);
    yield {
      type: "result",
      data: {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        ...("error" in answer ? { isError: true } : {}),
      },
    };
  }

  private answer(tool: string, args: Record<string, unknown>): Record<string, string> {
    switch (tool) {
      case "slack_send_message": {
        const id = String(args.channel_id ?? "");
        const known = id in EMULATED_SLACK_CONVERSATIONS || slackUser(id);
        if (!known) return { error: "channel_not_found" };
        return {
          result: `Message sent: https://emulated.slack.test/archives/${id}/p1761400000000100`,
        };
      }
      case "slack_read_user_profile": {
        const user = slackUser(String(args.user_id ?? ""));
        if (!user) return { error: "user_not_found" };
        return {
          result: [
            `User ID: ${user.id}`,
            `Username: ${user.name}`,
            `Display Name: ${user.name}`,
            `Real Name: ${user.real_name}`,
            "Title: ",
            "Status: ",
          ].join("\n"),
        };
      }
      case "slack_read_channel": {
        const channel = EMULATED_SLACK_CONVERSATIONS[String(args.channel_id ?? "")];
        if (!channel) return { error: "channel_not_found" };
        // The server heads a direct message's history without a name.
        if (typeof channel.name !== "string") {
          return { messages: `Channel: DM (${channel.id})\n\nMarie Dupont: Hi!` };
        }
        return {
          messages: `Channel: #${channel.name} (${channel.id})\n\nBob Martin: Launch is Friday.`,
        };
      }
      default:
        return { error: `unknown tool ${tool}` };
    }
  }
}

function slackUser(id: string) {
  return EMULATED_SLACK_USERS.find((user) => user.id === id);
}
