import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioEmulator } from "./composio-emulator.js";
import { SlackMcpEmulator } from "./slack-mcp-emulator.js";
import type { ChatRecipientCache } from "./slack-recipient.js";
import { lookUpChatRecipient, slackServer } from "./slack-recipient.js";

const context = (userId = "user-1"): AdapterContext => ({
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId,
  botId: "bot-1",
  signal: new AbortController().signal,
});

const direct = (channel: string): ConnectorCall => ({
  tool: "SLACK_SEND_MESSAGE",
  args: { channel, markdown_text: "Thursday instead?" },
  executionId: "call-1",
  route: { connectorId: "composio", toolName: "SLACK_SEND_MESSAGE" },
});

const batched = (channel: string): ConnectorCall => ({
  tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
  args: {
    tools: [
      {
        tool_slug: "SLACK_SEND_MESSAGE",
        account: "slack_acme",
        memory: { note: "Marie prefers Thursdays" },
        arguments: { channel, markdown_text: "Thursday instead?" },
      },
    ],
    thought: "Tell Marie",
    sync_response_to_workbench: true,
  },
  executionId: "call-1",
  route: { connectorId: "mcp", resourceId: "server-1", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL" },
});

/** A connector that answers every call with `data`. */
function answering(data: unknown) {
  return {
    calls: [] as ConnectorCall[],
    async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
      this.calls.push(call);
      yield { type: "result", data };
    },
  };
}

const marie = { kind: "person", name: "Marie Dupont", handle: "marie" };

describe("lookUpChatRecipient", () => {
  afterEach(() => vi.useRealTimers());

  it("names the person behind a direct message, asking Slack for the conversation then the user", async () => {
    const slack = new ComposioEmulator();
    expect(
      await lookUpChatRecipient(
        slack,
        direct("D0MARIE"),
        "composio",
        "D0MARIE",
        context(),
        new Map(),
      ),
    ).toEqual(marie);
    expect(slack.executions.map((call) => [call.tool, call.args])).toEqual([
      ["SLACK_RETRIEVE_CONVERSATION_INFORMATION", { channel: "D0MARIE" }],
      ["SLACK_RETRIEVE_DETAILED_USER_INFORMATION", { user: "U0MARIE" }],
    ]);
  });

  it.each([
    ["a user id", "U0MARIE", marie],
    ["a channel", "C0GENERAL", { kind: "channel", name: "general" }],
    ["a private channel", "C0LAUNCH", { kind: "channel", name: "launch" }],
  ])("names %s", async (_, id, named) => {
    expect(
      await lookUpChatRecipient(
        new ComposioEmulator(),
        direct(id),
        "composio",
        id,
        context(),
        new Map(),
      ),
    ).toEqual(named);
  });

  it("asks through Composio's batch with the send's account and nothing else the bot wrote", async () => {
    const slack = new ComposioEmulator();
    expect(
      await lookUpChatRecipient(
        slack,
        batched("C0GENERAL"),
        "composio",
        "C0GENERAL",
        context(),
        new Map(),
      ),
    ).toEqual({ kind: "channel", name: "general" });
    expect(slack.executions.map((call) => [call.tool, call.args])).toEqual([
      [
        "COMPOSIO_MULTI_EXECUTE_TOOL",
        {
          tools: [
            {
              tool_slug: "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
              account: "slack_acme",
              arguments: { channel: "C0GENERAL" },
            },
          ],
        },
      ],
    ]);
  });

  it.each([
    ["an id Slack does not know", "C0NOPE"],
    ["a channel name the bot wrote instead of an id", "general"],
  ])("names nothing for %s", async (_, id) => {
    expect(
      await lookUpChatRecipient(
        new ComposioEmulator(),
        direct(id),
        "composio",
        id,
        context(),
        new Map(),
      ),
    ).toBeUndefined();
  });

  it("names nothing when Slack fails or times out on the read", async () => {
    const failing = new ComposioEmulator();
    failing.failNext("SLACK_RETRIEVE_CONVERSATION_INFORMATION", {
      kind: "fail",
      error: "missing_scope",
    });
    const timingOut = new ComposioEmulator();
    timingOut.failNext("SLACK_RETRIEVE_CONVERSATION_INFORMATION", { kind: "timeout" });
    for (const slack of [failing, timingOut]) {
      expect(
        await lookUpChatRecipient(
          slack,
          direct("C0GENERAL"),
          "composio",
          "C0GENERAL",
          context(),
          new Map(),
        ),
      ).toBeUndefined();
    }
  });

  it("stops waiting for a read that never answers", async () => {
    vi.useFakeTimers();
    const slack = new ComposioEmulator();
    slack.failNext("SLACK_RETRIEVE_CONVERSATION_INFORMATION", { kind: "hang" });
    const named = lookUpChatRecipient(
      slack,
      direct("C0GENERAL"),
      "composio",
      "C0GENERAL",
      context(),
      new Map(),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await named).toBeUndefined();
  });

  it.each([
    ["another conversation", "C0GENERAL", { channel: { id: "C0OTHER", name: "random" } }],
    [
      "a group message, neither a person nor a channel",
      "G0TEAM",
      { channel: { id: "G0TEAM", is_mpim: true, name: "mpdm-a--b" } },
    ],
    ["a person with no name at all", "U0GHOST", { user: { id: "U0GHOST", profile: {} } }],
  ])("names nothing when Slack answers with %s", async (_, id, data) => {
    expect(
      await lookUpChatRecipient(
        answering({ data }),
        direct(id),
        "composio",
        id,
        context(),
        new Map(),
      ),
    ).toBeUndefined();
  });

  it.each([
    ["a display name that repeats the full name", { display_name: "marie dupont" }, "marie"],
    ["no display name", { display_name: "" }, "marie"],
    ["a username that repeats it too", { display_name: "Marie Dupont" }, undefined, "Marie Dupont"],
  ])(
    "gives the handle Slack users go by, never %s",
    async (_, profile, handle, username = "marie") => {
      const data = {
        user: { id: "U0MARIE", name: username, profile: { real_name: "Marie Dupont", ...profile } },
      };
      expect(
        await lookUpChatRecipient(
          answering({ data }),
          direct("U0MARIE"),
          "composio",
          "U0MARIE",
          context(),
          new Map(),
        ),
      ).toEqual({ kind: "person", name: "Marie Dupont", ...(handle ? { handle } : {}) });
    },
  );

  it("asks Slack again once a name it kept is ten minutes old", async () => {
    vi.useFakeTimers();
    const slack = new ComposioEmulator();
    const cache: ChatRecipientCache = new Map();
    const lookUp = () =>
      lookUpChatRecipient(slack, direct("C0GENERAL"), "composio", "C0GENERAL", context(), cache);
    await lookUp();
    vi.advanceTimersByTime(10 * 60_000 - 1);
    await lookUp();
    expect(slack.executions).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await lookUp()).toEqual({ kind: "channel", name: "general" });
    expect(slack.executions).toHaveLength(2);
  });

  it("reads Slack's answer inside an MCP result's JSON text", async () => {
    const text = JSON.stringify({
      successful: true,
      data: {
        results: [
          {
            response: {
              successful: true,
              data: { ok: true, channel: { id: "C0GENERAL", name: "general" } },
            },
          },
        ],
      },
    });
    expect(
      await lookUpChatRecipient(
        answering({ content: [{ type: "text", text }] }),
        batched("C0GENERAL"),
        "composio",
        "C0GENERAL",
        context(),
        new Map(),
      ),
    ).toEqual({ kind: "channel", name: "general" });
  });

  it("asks Slack again only after a failure, or for someone else", async () => {
    const slack = new ComposioEmulator();
    const cache: ChatRecipientCache = new Map();
    slack.failNext("SLACK_RETRIEVE_CONVERSATION_INFORMATION", {
      kind: "fail",
      error: "ratelimited",
    });
    expect(
      await lookUpChatRecipient(
        slack,
        direct("C0GENERAL"),
        "composio",
        "C0GENERAL",
        context(),
        cache,
      ),
    ).toBeUndefined();
    await lookUpChatRecipient(
      slack,
      direct("C0GENERAL"),
      "composio",
      "C0GENERAL",
      context(),
      cache,
    );
    await lookUpChatRecipient(
      slack,
      direct("C0GENERAL"),
      "composio",
      "C0GENERAL",
      context(),
      cache,
    );
    await lookUpChatRecipient(
      slack,
      direct("C0GENERAL"),
      "composio",
      "C0GENERAL",
      context("user-2"),
      cache,
    );
    expect(slack.executions.map((call) => call.tool)).toEqual([
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
    ]);
  });
});

describe("slackServer", () => {
  const mcp = (toolName: string): ConnectorCall => ({
    tool: `mcp__team__${toolName}`,
    args: {},
    executionId: "call-1",
    route: { connectorId: "mcp", resourceId: "server-1", toolName },
  });

  it("knows Composio natively and through its batch, and Slack's server by its endpoint only", () => {
    expect(slackServer(direct("C0GENERAL"))).toBe("composio");
    expect(slackServer(batched("C0GENERAL"))).toBe("composio");
    expect(slackServer(mcp("slack_send_message"), "https://mcp.slack.com/mcp")).toBe("slackMcp");
    expect(slackServer(mcp("slack_send_message"), "https://mcp.slack.com.evil.test/mcp")).toBe(
      undefined,
    );
    expect(slackServer(mcp("slack_send_message"), "https://slack-tools.example.test/mcp")).toBe(
      undefined,
    );
    expect(slackServer(mcp("slack_send_message"))).toBe(undefined);
  });
});

describe("lookUpChatRecipient through Slack's MCP server", () => {
  const send = (channel_id: string): ConnectorCall => ({
    tool: "mcp__slack__slack_send_message",
    args: { channel_id, message: "Thursday instead?" },
    executionId: "call-1",
    route: { connectorId: "mcp", resourceId: "server-1", toolName: "slack_send_message" },
  });
  const lookUp = (slack: { execute: SlackMcpEmulator["execute"] }, id: string) =>
    lookUpChatRecipient(slack, send(id), "slackMcp", id, context(), new Map());

  it("names a person from their profile and a channel from its history's header", async () => {
    const slack = new SlackMcpEmulator();
    expect(await lookUp(slack, "U0MARIE")).toEqual(marie);
    expect(await lookUp(slack, "C0GENERAL")).toEqual({ kind: "channel", name: "general" });
    expect(slack.executions).toEqual([
      {
        tool: "slack_read_user_profile",
        args: { user_id: "U0MARIE", response_format: "detailed" },
      },
      {
        tool: "slack_read_channel",
        args: { channel_id: "C0GENERAL", limit: 1, response_format: "concise" },
      },
    ]);
  });

  it("names nothing when the server errs, never answers, or names someone else", async () => {
    vi.useFakeTimers();
    const failing = new SlackMcpEmulator();
    failing.failNext("slack_read_user_profile", { kind: "fail", error: "user_not_found" });
    expect(await lookUp(failing, "U0MARIE")).toBeUndefined();
    const hanging = new SlackMcpEmulator();
    hanging.failNext("slack_read_channel", { kind: "hang" });
    const named = lookUp(hanging, "C0GENERAL");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await named).toBeUndefined();
    const text = (body: Record<string, string>) =>
      answering({ content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(await lookUp(text({ result: "User ID: U0BOB\nReal Name: Bob" }), "U0MARIE")).toBe(
      undefined,
    );
    for (const messages of [
      "Ana: see Channel: #general (C0GENERAL)",
      "Channel: DM (C0GENERAL)\n\nChannel: #ceo (C0GENERAL)",
    ]) {
      expect(await lookUp(text({ messages }), "C0GENERAL")).toBeUndefined();
    }
  });

  it("names nothing from an answer the server marked as an error", async () => {
    const failed = answering({
      content: [
        { type: "text", text: JSON.stringify({ result: "User ID: U0MARIE\nReal Name: Marie" }) },
      ],
      isError: true,
    });
    expect(await lookUp(failed, "U0MARIE")).toBeUndefined();
  });

  it("reads only the answer's JSON fields, never a raw text part", async () => {
    const raw = answering({
      content: [
        { type: "text", text: "User ID: U0MARIE\nDisplay Name: marie\nReal Name: Marie Dupont" },
      ],
    });
    expect(await lookUp(raw, "U0MARIE")).toBeUndefined();
  });

  it.each([
    ["a direct message, headed without a name", new SlackMcpEmulator(), "D0MARIE"],
    [
      "a group message",
      answering({
        content: [
          { type: "text", text: JSON.stringify({ messages: "Channel: #mpdm-ana--bo-1 (G0TEAM)" }) },
        ],
      }),
      "G0TEAM",
    ],
  ])("names nothing for %s", async (_, slack, id) => {
    expect(await lookUp(slack, id)).toBeUndefined();
  });

  it("asks nothing of a server it does not know", async () => {
    const slack = new SlackMcpEmulator();
    expect(
      await lookUpChatRecipient(slack, send("U0MARIE"), undefined, "U0MARIE", context(), new Map()),
    ).toBeUndefined();
    expect(slack.executions).toEqual([]);
  });
});
