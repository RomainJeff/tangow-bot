import { describe, expect, it } from "vitest";
import { composioEntityId, createConnectorStack } from "./composio-connector.js";
import { ComposioEmulator } from "./composio-emulator.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user-1",
  signal: new AbortController().signal,
};

const gmailContext = {
  ...context,
  connectedConnections: [
    {
      id: "connection-gmail",
      connectorId: "composio",
      externalId: "GMAIL",
      displayName: "Gmail",
    },
  ],
};

async function collectResults(
  emulator: ComposioEmulator,
  tool: string,
  args: Record<string, unknown>,
) {
  const events = [];
  for await (const event of emulator.execute(
    { tool, args, executionId: `exec-${tool}` },
    gmailContext,
  )) {
    events.push(event);
  }
  return events;
}

describe("ComposioEmulator", () => {
  it("remains registered when explicitly supplied without a live Composio key", () => {
    const emulator = new ComposioEmulator();
    const stack = createConnectorStack(false, emulator);

    expect(stack.connector.managed("composio")).toBe(emulator);
  });

  it("serves and searches a deterministic catalog", async () => {
    const emulator = new ComposioEmulator();

    await expect(emulator.catalog(context)).resolves.toHaveLength(6);
    await expect(emulator.catalog(context, "git")).resolves.toEqual([
      expect.objectContaining({ slug: "GITHUB", name: "GitHub", connected: false }),
    ]);
  });

  it("isolates connection state by space and user and supports revoke", async () => {
    const emulator = new ComposioEmulator();
    const otherSpace = { ...context, spaceId: "workspace-b" };
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);

    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(true);
    await expect(emulator.listConnectedSlugs(context)).resolves.toEqual(["GMAIL"]);
    await expect(emulator.connectionReady({ ...context, userId: "user-2" }, "GMAIL")).resolves.toBe(
      false,
    );
    await expect(emulator.connectionReady(otherSpace, "GMAIL")).resolves.toBe(false);
    await expect(emulator.listConnectedSlugs(otherSpace)).resolves.toEqual([]);
    await expect(emulator.catalog(context, "gmail")).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL", connected: true }),
    ]);
    await expect(emulator.catalog(otherSpace, "gmail")).resolves.toEqual([
      expect.objectContaining({ slug: "GMAIL", connected: false }),
    ]);
    expect(emulator.mailboxFor(composioEntityId(context))?.messages.length).toBeGreaterThan(0);

    await emulator.revoke("GMAIL", context);
    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(false);
    expect(emulator.mailboxFor(composioEntityId(context))).toBeUndefined();
  });

  it("keeps a revoke in one space from touching another space", async () => {
    const emulator = new ComposioEmulator();
    const otherSpace = { ...context, spaceId: "workspace-b" };
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, otherSpace);

    await emulator.revoke("GMAIL", otherSpace);

    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(true);
    await expect(emulator.connectionReady(otherSpace, "GMAIL")).resolves.toBe(false);
  });

  it("keeps the shared Gmail mailbox until the last connection is revoked", async () => {
    const emulator = new ComposioEmulator();
    const first = await emulator.begin(
      { provider: "GMAIL", redirectUrl: "http://example.test" },
      context,
    );
    const second = await emulator.begin(
      { provider: "GMAIL", redirectUrl: "http://example.test" },
      context,
    );
    expect(first.state).not.toEqual(second.state);
    expect(first.state.startsWith("GMAIL:")).toBe(true);
    expect(second.state.startsWith("GMAIL:")).toBe(true);

    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(true);
    expect(emulator.mailboxFor(composioEntityId(context))?.messages.length).toBeGreaterThan(0);

    await emulator.revoke(first.state, context);
    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(true);
    expect(emulator.mailboxFor(composioEntityId(context))).toBeDefined();

    await emulator.revoke(second.state, context);
    await expect(emulator.connectionReady(context, "GMAIL")).resolves.toBe(false);
    expect(emulator.mailboxFor(composioEntityId(context))).toBeUndefined();
  });

  it("runs a batch of sends and reports each action in order", async () => {
    const emulator = new ComposioEmulator();
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);

    const events = await collectResults(emulator, "COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        {
          tool_slug: "GMAIL_REPLY_TO_THREAD",
          account: "gmail_test",
          arguments: { thread_id: "18c5f5d1a2b3c4d6", message_body: "On it." },
        },
        {
          tool_slug: "OUTLOOK_SEND_EMAIL",
          arguments: { to: "b@example.test", subject: "Hi", body: "Hello" },
        },
        { tool_slug: "GMAIL_SEND_DRAFT", arguments: { draft_id: "missing" } },
      ],
    });

    expect(events).toEqual([
      {
        type: "result",
        data: {
          successful: false,
          data: {
            results: [
              {
                response: {
                  successful: true,
                  data: { messageId: "18c5f5e1", threadId: "18c5f5d1a2b3c4d6", labelIds: ["SENT"] },
                },
                tool_slug: "GMAIL_REPLY_TO_THREAD",
                index: 0,
              },
              {
                response: { successful: true, data: {} },
                tool_slug: "OUTLOOK_SEND_EMAIL",
                index: 1,
              },
              {
                response: { successful: false, error: "Draft not found: missing", data: null },
                tool_slug: "GMAIL_SEND_DRAFT",
                index: 2,
              },
            ],
            success_count: 2,
            error_count: 1,
          },
          error: null,
        },
      },
    ]);
    const sent = emulator
      .mailboxFor(composioEntityId(context))
      ?.messages.slice(-2)
      .map((message) => [message.to, message.subject, message.messageText]);
    expect(sent).toEqual([
      ["teammate@example.test", "Re: Quarterly planning notes", "On it."],
      ["b@example.test", "Hi", "Hello"],
    ]);
  });

  it("fails the next send as asked, or sends it and then times out", async () => {
    const emulator = new ComposioEmulator();
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);
    const send = { recipient_email: "a@example.test", subject: "Hi", body: "Hello" };
    const sentCount = () => emulator.mailboxFor(composioEntityId(context))?.messages.length;
    const before = sentCount();

    emulator.failNext("GMAIL_SEND_EMAIL", { kind: "fail", error: "Invalid recipient" });
    const failed = await collectResults(emulator, "COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: send }],
    });
    expect(failed[0]).toMatchObject({
      data: {
        successful: false,
        data: { results: [{ response: { successful: false, error: "Invalid recipient" } }] },
      },
    });
    expect(sentCount()).toBe(before);

    emulator.failNext("GMAIL_SEND_EMAIL", { kind: "timeout" });
    expect(await collectResults(emulator, "GMAIL_SEND_EMAIL", send)).toEqual([
      { type: "error", message: "GMAIL_SEND_EMAIL timed out" },
    ]);
    expect(sentCount()).toBe(before! + 1);

    expect(await collectResults(emulator, "GMAIL_SEND_EMAIL", send)).toMatchObject([
      { data: { successful: true } },
    ]);
  });

  it("accepts BCC-only Gmail send recipients", async () => {
    const emulator = new ComposioEmulator();
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);

    const events = await collectResults(emulator, "GMAIL_SEND_EMAIL", {
      bcc: ["hidden@example.test"],
      subject: "BCC only",
      body: "Sent with bcc only",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          successful: true,
          data: expect.objectContaining({
            messageId: expect.any(String),
          }),
        }),
      }),
    );
    const sent = emulator
      .mailboxFor(composioEntityId(context))
      ?.messages.find((message) => message.subject === "BCC only");
    expect(sent).toMatchObject({
      to: "hidden@example.test",
      messageText: "Sent with bcc only",
      labelIds: ["SENT"],
    });
  });

  it("discovers realistic Gmail and Slack tools and keeps thin actions for other apps", async () => {
    const emulator = new ComposioEmulator();
    const tools = await emulator.discoverTools({
      ...context,
      connectedConnections: [
        {
          id: "connection-gmail",
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Gmail",
        },
        {
          id: "connection-slack",
          connectorId: "composio",
          externalId: "SLACK",
          displayName: "Slack",
        },
        {
          id: "connection-notion",
          connectorId: "composio",
          externalId: "NOTION",
          displayName: "Notion",
        },
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_SEND_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_LIST_LABELS",
      "GMAIL_REPLY_TO_THREAD",
      "GMAIL_SEND_DRAFT",
      "GMAIL_FORWARD_MESSAGE",
      "SLACK_SEND_MESSAGE",
      "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
      "SLACK_RETRIEVE_DETAILED_USER_INFORMATION",
      "NOTION_EMULATED_ACTION",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
    ]);
    expect(tools.find((tool) => tool.name === "GMAIL_FETCH_EMAILS")).toMatchObject({
      appName: "Gmail",
      readOnly: true,
      route: {
        connectorId: "composio",
        resourceId: "GMAIL",
        resourceRevision: "emulated",
        toolName: "GMAIL_FETCH_EMAILS",
        catalogGroup: "gmail",
      },
    });
    expect(tools.find((tool) => tool.name === "GMAIL_SEND_EMAIL")?.readOnly).toBeUndefined();
    expect(tools.find((tool) => tool.name === "SLACK_SEND_MESSAGE")).toMatchObject({
      appName: "Slack",
      route: {
        connectorId: "composio",
        resourceId: "SLACK",
        resourceRevision: "emulated",
        toolName: "SLACK_SEND_MESSAGE",
        catalogGroup: "slack",
      },
    });
    expect(
      tools.find((tool) => tool.name === "SLACK_RETRIEVE_CONVERSATION_INFORMATION")?.readOnly,
    ).toBe(true);
    expect(tools.find((tool) => tool.name === "GMAIL_SEND_EMAIL")?.inputSchema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        recipient_email: expect.any(Object),
        subject: expect.any(Object),
        body: expect.any(Object),
      }),
      required: ["subject"],
    });
  });

  it("round-trips Gmail fetch and send against in-memory mailbox state", async () => {
    const emulator = new ComposioEmulator();
    await emulator.begin({ provider: "GMAIL", redirectUrl: "http://example.test" }, context);

    const fetchEvents = await collectResults(emulator, "GMAIL_FETCH_EMAILS", {
      query: "from:teammate",
      max_results: 5,
    });
    expect(fetchEvents).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          successful: true,
          data: expect.objectContaining({
            messages: [
              expect.objectContaining({
                messageId: "18c5f5d1a2b3c4d6",
                subject: "Quarterly planning notes",
                snippet: expect.stringContaining("planning"),
              }),
            ],
            resultSizeEstimate: 1,
          }),
        }),
      }),
    );

    const sendEvents = await collectResults(emulator, "GMAIL_SEND_EMAIL", {
      recipient_email: "friend@example.test",
      subject: "Hello from emulator",
      body: "Deterministic send body",
    });
    expect(sendEvents).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          successful: true,
          data: expect.objectContaining({
            messageId: expect.any(String),
            threadId: expect.any(String),
            labelIds: ["SENT"],
          }),
        }),
      }),
    );

    const sent = emulator
      .mailboxFor(composioEntityId(context))
      ?.messages.find((message) => message.subject === "Hello from emulator");
    expect(sent).toMatchObject({
      to: "friend@example.test",
      messageText: "Deterministic send body",
      labelIds: ["SENT"],
    });

    const listed = await collectResults(emulator, "GMAIL_FETCH_EMAILS", {
      query: "subject:Hello",
      max_results: 10,
    });
    expect(listed[0]).toMatchObject({
      type: "result",
      data: {
        successful: true,
        data: {
          messages: [expect.objectContaining({ subject: "Hello from emulator" })],
          resultSizeEstimate: 1,
        },
      },
    });

    expect(emulator.executions.map((entry) => entry.tool)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "GMAIL_FETCH_EMAILS",
    ]);
  });

  it("exposes seeded GitHub release tools without live OAuth", async () => {
    const emulator = new ComposioEmulator();
    const connectedContext = {
      ...context,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "GITHUB",
          displayName: "GitHub",
        },
      ],
    };

    const tools = await emulator.discoverTools(connectedContext);
    expect(tools.map((tool) => tool.name)).toEqual([
      "GITHUB_LIST_RELEASES",
      "GITHUB_GET_RELEASE",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
    ]);
    expect(tools.map((tool) => tool.name)).not.toContain("GITHUB_EMULATED_ACTION");

    const events = [];
    for await (const event of emulator.execute(
      {
        tool: "GITHUB_LIST_RELEASES",
        args: { owner: "elie222", repo: "rakazo" },
        executionId: "github-list-releases",
      },
      connectedContext,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          ok: true,
          releases: expect.arrayContaining([
            expect.objectContaining({ tag: "v0.4.2" }),
            expect.objectContaining({ tag: "v0.4.1" }),
          ]),
        }),
      }),
    );
    expect(emulator.listGithubReleases()[0]?.tag).toBe("v0.4.2");
  });
});
