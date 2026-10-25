import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioEmulator } from "./composio-emulator.js";
import type { ChatRecipientCache } from "./slack-recipient.js";
import { lookUpChatRecipient } from "./slack-recipient.js";

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
        arguments: { channel, markdown_text: "Thursday instead?" },
      },
    ],
    thought: "Tell Marie",
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
      await lookUpChatRecipient(slack, direct("D0MARIE"), "D0MARIE", context(), new Map()),
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
      await lookUpChatRecipient(new ComposioEmulator(), direct(id), id, context(), new Map()),
    ).toEqual(named);
  });

  it("asks through Composio's batch with the send's own account", async () => {
    const slack = new ComposioEmulator();
    expect(
      await lookUpChatRecipient(slack, batched("C0GENERAL"), "C0GENERAL", context(), new Map()),
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
          thought: "Tell Marie",
        },
      ],
    ]);
  });

  it.each([
    ["an id Slack does not know", "C0NOPE"],
    ["a channel name the bot wrote instead of an id", "general"],
  ])("names nothing for %s", async (_, id) => {
    expect(
      await lookUpChatRecipient(new ComposioEmulator(), direct(id), id, context(), new Map()),
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
        await lookUpChatRecipient(slack, direct("C0GENERAL"), "C0GENERAL", context(), new Map()),
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
      await lookUpChatRecipient(answering({ data }), direct(id), id, context(), new Map()),
    ).toBeUndefined();
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
      await lookUpChatRecipient(slack, direct("C0GENERAL"), "C0GENERAL", context(), cache),
    ).toBeUndefined();
    await lookUpChatRecipient(slack, direct("C0GENERAL"), "C0GENERAL", context(), cache);
    await lookUpChatRecipient(slack, direct("C0GENERAL"), "C0GENERAL", context(), cache);
    await lookUpChatRecipient(slack, direct("C0GENERAL"), "C0GENERAL", context("user-2"), cache);
    expect(slack.executions.map((call) => call.tool)).toEqual([
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
    ]);
  });
});
