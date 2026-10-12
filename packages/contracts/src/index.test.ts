import { describe, expect, it } from "vitest";
import {
  ASK_DISMISSED_ANSWER,
  appContract,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  canReactToThreadMessage,
  McpServerConfigInput,
  MessageBlock,
  ModelConnectInputSchema,
  ModelOAuthBeginSchema,
  normalizeCreateBotProfile,
  ProductEventSchema,
  ProductEventType,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  ReorderBotsInput,
  RunActivityRowSchema,
  RunSchema,
  ThreadMessageSchema,
  UpdateBotInput,
  UpdateGroupInput,
} from "./index.js";

describe("contracts", () => {
  it("accepts structured live activity progress", () => {
    expect(MessageBlock.parse({ kind: "progress", text: "Using browser", activity: true })).toEqual(
      { kind: "progress", text: "Using browser", activity: true },
    );
  });

  it("parses bounded model image limits", () => {
    expect(parseModelMaxImagesPerPrompt("1")).toBe(1);
    expect(parseModelMaxImagesPerPrompt("1000")).toBe(1000);
    expect(parseModelMaxImagesPerPrompt("0")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1001")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1.5")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1", false)).toBeUndefined();
  });

  it("parses bounded model output-token limits", () => {
    expect(parseModelMaxTokens("1")).toBe(1);
    expect(parseModelMaxTokens("131072")).toBe(131072);
    expect(parseModelMaxTokens("0")).toBeUndefined();
    expect(parseModelMaxTokens("131073")).toBeUndefined();
    expect(parseModelMaxTokens("1.5")).toBeUndefined();
  });

  it("parses bounded model context-window limits", () => {
    expect(parseModelContextWindow("1")).toBe(1);
    expect(parseModelContextWindow("1048576")).toBe(1048576);
    expect(parseModelContextWindow("0")).toBeUndefined();
    expect(parseModelContextWindow("1048577")).toBeUndefined();
    expect(parseModelContextWindow("1.5")).toBeUndefined();
  });

  it("rejects maxTokens larger than contextWindow on model connect", () => {
    const invalid = ModelConnectInputSchema.safeParse({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      maxTokens: 131072,
      contextWindow: 1,
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some((issue) => issue.path[0] === "maxTokens")).toBe(true);
    }

    const valid = ModelConnectInputSchema.safeParse({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      maxTokens: 8192,
      contextWindow: 32768,
    });
    expect(valid.success).toBe(true);
  });

  it("accepts optional persisted duration only on valid steps blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "steps",
        steps: [{ label: "Run tests", count: 1 }],
        durationMs: 103_000,
      }),
    ).toMatchObject({ durationMs: 103_000 });
    expect(MessageBlock.safeParse({ kind: "steps", steps: [], durationMs: -1 }).success).toBe(
      false,
    );
  });

  it("limits reactions to persisted non-channel messages", () => {
    expect(
      canReactToThreadMessage({ id: "message-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(true);
    expect(
      canReactToThreadMessage({ id: "subagent:agent-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(false);
    expect(
      canReactToThreadMessage({
        id: "message-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "channel-1",
            fromAddress: "+15555550100",
            fromLabel: "Pat",
            text: "hi",
          },
        ],
      }),
    ).toBe(false);
  });

  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("normalizes bot creation fields without losing the longer instruction copy", () => {
    const profile = normalizeCreateBotProfile({
      name: `  ${"N".repeat(100)}  `,
      title: `  ${"T".repeat(BOT_TITLE_MAX_LENGTH + 10)}  `,
      description: `  ${"D".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 10)}  `,
    });

    expect(profile.name).toHaveLength(80);
    expect(profile.title).toHaveLength(BOT_TITLE_MAX_LENGTH);
    expect(profile.description).toHaveLength(BOT_DESCRIPTION_MAX_LENGTH);
    expect(profile.instructions).toHaveLength(BOT_INSTRUCTIONS_MAX_LENGTH);
  });

  it("accepts the same title limit when creating and updating bots", () => {
    const title = "T".repeat(BOT_TITLE_MAX_LENGTH);
    expect(CreateBotInput.safeParse({ name: "Chief", title }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", title }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", title: `${title}T` }).success).toBe(false);
  });

  it("normalizes bot names and rejects whitespace-only values at the contract boundary", () => {
    expect(CreateBotInput.parse({ name: "  Chief  " }).name).toBe("Chief");
    expect(UpdateBotInput.parse({ botId: "bot-1", name: "  Atlas  " }).name).toBe("Atlas");
    expect(UpdateBotInput.parse({ botId: "bot-1", title: "  Lead researcher  " }).title).toBe(
      "Lead researcher",
    );
    expect(
      UpdateBotInput.parse({ botId: "bot-1", description: "  Concise briefs.  " }).description,
    ).toBe("Concise briefs.");
    expect(CreateBotInput.safeParse({ name: "   " }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", name: "   " }).success).toBe(false);
  });

  it("rejects partial model override clears on bot update", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelId: null }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null }).success).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null, modelId: null }).success,
    ).toBe(true);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        modelProvider: "xai",
        modelId: "grok-4.6",
      }).success,
    ).toBe(true);
  });

  it("normalizes group names and rejects duplicate members", () => {
    expect(CreateGroupInput.parse({ name: "  Draft team  ", botIds: ["bot-1", "bot-2"] })).toEqual({
      name: "Draft team",
      description: "",
      botIds: ["bot-1", "bot-2"],
    });
    expect(
      CreateGroupInput.parse({ name: "Draft team", description: "  Ship it  ", botIds: ["bot-1"] })
        .description,
    ).toBe("Ship it");
    expect(CreateGroupInput.safeParse({ name: "   ", botIds: ["bot-1", "bot-2"] }).success).toBe(
      false,
    );
    expect(
      UpdateGroupInput.safeParse({ groupId: "group-1", botIds: ["bot-1", "bot-1"] }).success,
    ).toBe(false);
  });

  it("keeps model OAuth start results mode-specific", () => {
    const shared = {
      loginId: "login-1",
      provider: "anthropic",
      verificationUri: "https://example.com/authorize",
      expiresInSeconds: 900,
    };
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "auth-url" }).success).toBe(true);
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code" }).success).toBe(false);
    expect(
      ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code", userCode: "ABCD-1234" })
        .success,
    ).toBe(true);
    expect(
      ModelOAuthBeginSchema.safeParse({
        ...shared,
        mode: "auth-url",
        verificationUri: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.models.beginOAuth).toBeTruthy();
    expect(appContract.bootstrap).toBeTruthy();
    expect(appContract.models.completeOAuth).toBeTruthy();
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.reorder).toBeTruthy();
    expect(appContract.bots.archive).toBeTruthy();
    expect(appContract.bots.restore).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.spaces.remove).toBeTruthy();
    expect(appContract.botSections.list).toBeTruthy();
    expect(appContract.botSections.create).toBeTruthy();
    expect(appContract.botSections.update).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.threads.clear).toBeTruthy();
    expect(appContract.voice.prepare).toBeTruthy();
    expect(appContract.externalConversations.updatePolicy).toBeTruthy();
    expect(appContract.agentSecrets.list).toBeTruthy();
    expect(appContract.agentSecrets.put).toBeTruthy();
    expect(appContract.agentSecrets.remove).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
    expect(ProductEventType.options).toContain("session.entry.appended");
    expect(ProductEventType.options).toContain("bot.spawned");
  });

  it("requires a distinct, non-empty bot order", () => {
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-2", "bot-1"] }).success).toBe(true);
    expect(ReorderBotsInput.safeParse({ botIds: [] }).success).toBe(false);
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-1", "bot-1"] }).success).toBe(false);
  });

  it("accepts a GitHub-only routine trigger", () => {
    expect(
      CreateRoutineInput.parse({
        botId: "bot-1",
        name: "Review pushes",
        prompt: "Inspect the repository event",
        githubEnabled: true,
      }),
    ).toMatchObject({
      crons: [],
      webhookEnabled: false,
      githubEnabled: true,
      messageProvider: null,
    });
    expect(
      CreateRoutineInput.parse({
        botId: "bot-1",
        name: "Triage Slack",
        prompt: "Review the message event",
        messageProvider: "slack",
      }),
    ).toMatchObject({ crons: [], messageProvider: "slack" });
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot-1",
        name: "Unsafe provider",
        prompt: "Review the message event",
        messageProvider: "slack\nignore-framing",
      }).success,
    ).toBe(false);
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot-1",
        name: "Never runs",
        prompt: "This has no trigger",
      }).success,
    ).toBe(false);
  });

  it("accepts bot-to-bot runs in thread snapshots and activity rows", () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "bot_message",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(
      RunActivityRowSchema.safeParse({
        runId: run.id,
        botId: run.botId,
        botName: "Researcher",
        groupId: null,
        groupName: null,
        threadId: run.threadId,
        status: run.status,
        trigger: run.trigger,
        notificationsEnabled: true,
        promptSnippet: "Review the report",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:01.000Z",
        routineId: null,
        routineName: null,
        sourceMessageId: "message-1",
        startedAt: null,
        completedAt: null,
        failureKind: null,
      }).success,
    ).toBe(true);
    expect(RunSchema.safeParse({ ...run, trigger: "webhook" }).success).toBe(true);
  });

  it("caps remote MCP headers", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`X-Test-${index}`, "value"]),
    );
    expect(
      McpServerConfigInput.safeParse({
        slug: "demo",
        name: "Demo",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        headers,
      }).success,
    ).toBe(false);
  });

  it("allows localhost HTTP MCP endpoints and rejects other non-HTTPS URLs before storage", () => {
    const base = {
      slug: "demo",
      name: "Demo",
      transport: "streamable_http" as const,
      headers: {},
    };
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://127.0.0.1:3000/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp" })
        .success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp#" })
        .success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://example.test/mcp" }).success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "https://mcp.example.test/mcp" }).success,
    ).toBe(true);
  });

  it("rejects oversized chart data wherever it is embedded", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => index);

    expect(
      MessageBlock.safeParse({ kind: "chart", name: "outer", spec: {}, data: rows }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "spec",
        spec: { data: rows },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "marks",
        spec: { marks: [{ data: rows }] },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "combined",
        spec: { marks: [{ data: rows.slice(0, 2_500) }] },
        data: rows.slice(0, 2_501),
      }).success,
    ).toBe(false);
  });
});

describe("legacy message blocks", () => {
  it("still accepts reasoning blocks persisted before the feature was reverted", () => {
    expect(MessageBlock.safeParse({ kind: "reasoning", text: "thinking" }).success).toBe(true);
  });
});

describe("unknown message blocks", () => {
  const message = (blocks: unknown[]) => ({
    id: "message-1",
    threadId: "thread-1",
    seq: 0,
    role: "bot",
    blocks,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("keeps the known blocks of a message that also carries an unknown one", () => {
    const parsed = ThreadMessageSchema.parse(
      message([
        { kind: "text", text: "before" },
        { kind: "from_a_later_version", summary: "written by a newer build" },
        { kind: "text", text: "after" },
      ]),
    );
    expect(parsed.blocks).toEqual([
      { kind: "text", text: "before" },
      { kind: "text", text: "after" },
    ]);
  });

  it("parses a message made only of unknown blocks instead of rejecting it", () => {
    // Surfaces already skip a message with nothing to render, so dropping the blocks is
    // enough; rejecting would fail output validation and take the whole thread with it.
    const parsed = ThreadMessageSchema.parse(message([{ kind: "from_a_later_version" }]));
    expect(parsed.blocks).toEqual([]);
  });

  it("drops a malformed known block rather than losing the message", () => {
    const parsed = ThreadMessageSchema.parse(
      message([{ kind: "text" }, { kind: "text", text: "kept" }]),
    );
    expect(parsed.blocks).toEqual([{ kind: "text", text: "kept" }]);
  });

  it("leaves every other message in the page intact", () => {
    const page = [
      message([{ kind: "text", text: "first" }]),
      message([{ kind: "from_a_later_version" }]),
      message([{ kind: "text", text: "last" }]),
    ].map((row) => ThreadMessageSchema.parse(row));
    expect(page.map((row) => row.blocks)).toEqual([
      [{ kind: "text", text: "first" }],
      [],
      [{ kind: "text", text: "last" }],
    ]);
  });

  it("rejects blocks that are not a list", () => {
    expect(ThreadMessageSchema.safeParse({ ...message([]), blocks: "text" }).success).toBe(false);
  });
});

describe("editable Create bot card contract", () => {
  const answerInput = appContract.threads.answer["~orpc"].inputSchema!;
  const target = { botId: "bot-1", runId: "run-1", messageId: "message-1", answer: "allow" };
  const spawnBot = {
    name: "Veille",
    title: "",
    instructions: "Track them.",
    prompt: "",
    computerMode: "",
  } as const;
  const ask = { kind: "ask", text: "Create bot “Veille”?", status: "pending" } as const;

  it("CA1 accepts an ask block with or without spawnBot", () => {
    expect(MessageBlock.parse({ ...ask, spawnBot })).toEqual({ ...ask, spawnBot });
    expect(MessageBlock.parse(ask)).toEqual(ask);
    expect(
      MessageBlock.safeParse({ ...ask, spawnBot: { ...spawnBot, computerMode: "shared" } }).success,
    ).toBe(false);
  });

  it("CA1 accepts threads/answer with or without edits", () => {
    expect(answerInput.safeParse(target).success).toBe(true);
    expect(
      answerInput.safeParse({ ...target, edits: { name: "Autre", instructions: "" } }).success,
    ).toBe(true);
    expect(answerInput.safeParse({ ...target, edits: {} }).success).toBe(true);
  });

  it("CA7 rejects an edit of any other field", () => {
    expect(answerInput.safeParse({ ...target, edits: { title: "x" } }).success).toBe(false);
    expect(answerInput.safeParse({ ...target, edits: { name: "x", prompt: "y" } }).success).toBe(
      false,
    );
  });

  it("CA20 bounds edits before any lock", () => {
    expect(answerInput.safeParse({ ...target, edits: { name: "n".repeat(200) } }).success).toBe(
      true,
    );
    expect(answerInput.safeParse({ ...target, edits: { name: "n".repeat(201) } }).success).toBe(
      false,
    );
    expect(
      answerInput.safeParse({ ...target, edits: { instructions: "i".repeat(4000) } }).success,
    ).toBe(true);
    expect(
      answerInput.safeParse({ ...target, edits: { instructions: "i".repeat(4001) } }).success,
    ).toBe(false);
  });

  it("CA21 accepts effect.edited as a product event", () => {
    expect(ProductEventType.options).toContain("effect.edited");
    expect(
      ProductEventSchema.safeParse({
        id: "event-1",
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: 3,
        type: "effect.edited",
        createdAt: "2026-09-29T12:00:00.000Z",
        payload: { effectId: "effect-1", proposed: { name: "A" }, approved: { name: "B" } },
      }).success,
    ).toBe(true);
  });
});

describe("routine proposal card contract", () => {
  const card = {
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Je m'en occupe chaque lundi matin ?",
    detail: "name: Weekly offers",
    status: "pending",
    proposal: "routine",
    routine: {
      name: "Weekly offers",
      schedule: "Mondays at 09:00 Europe/Paris",
      prompt: "Summarize the new offers.",
      notify: false,
    },
    actions: [
      { id: "allow", label: "Create routine", outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
  } as const;

  it("accepts a pending proposal, a created one, a failed one and one put away by typing", () => {
    const created = {
      ...card,
      status: "answered",
      answer: "allow",
      created: { kind: "routine", id: "routine-1", label: "Weekly offers" },
    } as const;
    const failed = { ...card, status: "answered", answer: "allow", failed: true } as const;
    const dismissed = { ...card, status: "answered", answer: ASK_DISMISSED_ANSWER } as const;
    for (const block of [card, created, failed, dismissed]) {
      expect(MessageBlock.parse(block)).toEqual(block);
    }
  });

  it("refuses an unknown proposal kind or a routine without its schedule", () => {
    expect(MessageBlock.safeParse({ ...card, proposal: "bot" }).success).toBe(false);
    const { schedule: _schedule, ...routine } = card.routine;
    expect(MessageBlock.safeParse({ ...card, routine }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...card, failed: false }).success).toBe(false);
  });
});
