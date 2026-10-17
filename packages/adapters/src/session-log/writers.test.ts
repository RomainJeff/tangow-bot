import { randomUUID } from "node:crypto";
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import type { FactualRunRecap, MessageBlock, SessionEntry } from "@rakazo/contracts";
import { EntryId, EntrySeq, SessionId } from "@rakazo/contracts";
import {
  projectThreadItems,
  projectThreadView,
  spawnBotApprovalBlock,
  visibleEntries,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  answerRunInputInTransaction,
  appendEventInTransaction,
  appendLinkBlocks,
  appendRunBlocksInTransaction,
  appendRunFinishedInTransaction,
  appendSessionEntryInTransaction,
  cancelRunsInTransaction,
  clearThread,
  createBotMessageInTransaction,
  createSessionInTransaction,
  createThreadEvents,
  createThreadMessageInTransaction,
  dismissProposalWithTextInTransaction,
  finalizeRun,
  openRoutineSessionInTransaction,
  pauseRunForInput,
  progressSinceLastEntry,
  removeLinkPreviewBlock,
  resumeAskWithComposerTextInTransaction,
  rewindThread,
  runsOfMessage,
  threadOfSession,
} from "@rakazo/db";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageConnectedAgent } from "../agent-connections.js";
import { messageBot, returnBotMessageOutcome } from "../bot-messages.js";
import { openRunLog } from "../executor.js";
import { createSkillLineSweep, writeSkillLines } from "../skill-lines.js";
import { PostgresSessionLog } from "./postgres.js";

const SPACE = "space_writers";
const USER = "user_writers";

async function seedBot(prisma: PrismaClient, name: string) {
  const bot = await prisma.bot.create({
    data: { spaceId: SPACE, userId: USER, name, color: "#00C46A" },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  return { bot, threadId: thread.id, sessionId: thread.sessionId as SessionId };
}

async function seedRun(
  prisma: PrismaClient,
  botId: string,
  threadId: string,
  started: {
    trigger?: string;
    routineId?: string;
    parentRunId?: string;
    leaseOwner?: string;
    leaseFence?: number;
  } = {},
) {
  const task = await prisma.task.create({
    data: { spaceId: SPACE, botId, threadId, userId: USER, prompt: "", status: "running" },
  });
  return prisma.run.create({
    data: {
      spaceId: SPACE,
      botId,
      threadId,
      taskId: task.id,
      userId: USER,
      status: "running",
      trigger: "user",
      ...started,
    },
  });
}

const SCHEDULED_AT = "2026-10-11T07:00:00.000Z";
const SCRIPTED = { provider: "scripted", id: "scripted" };

/** Appends what the run writes, addressed to the session the run row names. */
function writerOf(prisma: PrismaClient, run: { id: string; botId: string }) {
  return async (body: object) => {
    const { sessionId } = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    return prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        ...body,
        sessionId: sessionId as SessionId,
        botId: run.botId,
        runId: run.id,
      } as SessionEntryDraft),
    );
  };
}

/** A helper of `parent`'s run, in a session under the one that run writes to, its log started. */
async function subagentRun(
  prisma: PrismaClient,
  parent: { id: string; botId: string; threadId: string },
) {
  const run = await seedRun(prisma, parent.botId, parent.threadId, {
    trigger: "subagent",
    parentRunId: parent.id,
  });
  const call = await writerOf(
    prisma,
    parent,
  )({
    type: "tool.call",
    payload: { callId: `call_${run.id}`, name: "run_subagent", input: "{}" },
  });
  const sessionId = await prisma.$transaction(async (tx) => {
    const created = await createSessionInTransaction(tx, {
      kind: "subagent",
      id: SessionId.parse(randomUUID()),
      spaceId: SPACE,
      parentSessionId: call.sessionId,
      parentEntryId: call.id,
    });
    await tx.run.update({ where: { id: run.id }, data: { sessionId: created } });
    return created;
  });
  const write = writerOf(prisma, run);
  await write({
    type: "run.started",
    payload: { trigger: { kind: "subagent", entryId: call.id }, model: SCRIPTED, effort: null },
  });
  return { run, sessionId, write };
}

/** A run of the routine `name` in the bot's thread, with its own session open and its log started. */
async function routineRun(
  prisma: PrismaClient,
  { bot, threadId }: Awaited<ReturnType<typeof seedBot>>,
  name: string,
  started: Parameters<typeof seedRun>[3] = {},
) {
  const run = await seedRun(prisma, bot.id, threadId, started);
  const routineSessionId = await prisma.$transaction((tx) =>
    openRoutineSessionInTransaction(tx, run, {
      routineId: "rtn_digest",
      name,
      trigger: "routine",
      scheduledAt: SCHEDULED_AT,
      model: SCRIPTED,
    }),
  );
  const write = writerOf(prisma, run);
  await write({
    type: "run.started",
    payload: {
      trigger: { kind: "routine", routineId: "rtn_digest", name, scheduledAt: SCHEDULED_AT },
      model: SCRIPTED,
      effort: null,
    },
  });
  return { run, routineSessionId, write };
}

const shape = ({ id, type, parentId, payload }: SessionEntry) => ({ id, type, parentId, payload });

describe("session log writers", () => {
  let database: PgliteDatabase;
  let log: PostgresSessionLog;

  beforeAll(async () => {
    database = await openPgliteDatabase();
    log = new PostgresSessionLog(database.prisma);
    const { prisma } = database;
    await prisma.user.create({ data: { id: USER, name: "W", email: "w@rakazo.test" } });
    await prisma.organization.create({
      data: { id: "org_writers", name: "W", slug: "org-writers", createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: SPACE, organizationId: "org_writers", name: "General" },
    });
  });
  afterAll(() => database.close());
  const types = async (id: SessionId) => (await log.readTail(id)).map((entry) => entry.type);
  const origins = async (id: SessionId) =>
    (await log.readTail(id)).map(({ type, payload }) => [
      type,
      (payload as { originSessionId?: string }).originSessionId,
    ]);

  it("links a request and its result between two bots as one exchange, delivered once", async () => {
    const { prisma } = database;
    const asker = await seedBot(prisma, "Researcher");
    const helper = await seedBot(prisma, "Analyst");
    const askerRun = await seedRun(prisma, asker.bot.id, asker.threadId);
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof messageBot>[0];
    const request = { bot_id: helper.bot.id, message: "Chart Q3", deliveryKey: "call-1" };

    await messageBot(deps, askerRun, asker.bot, request);
    const replayed = await messageBot(deps, askerRun, asker.bot, request);
    const helperRun = await prisma.run.findFirstOrThrow({ where: { botId: helper.bot.id } });
    await prisma.run.update({ where: { id: helperRun.id }, data: { status: "running" } });
    await messageBot(deps, helperRun, helper.bot, {
      bot_id: asker.bot.id,
      message: "Q3 is up 4%",
      intent: "result",
      deliveryKey: "call-2",
    });

    const askerLog = await log.readTail(asker.sessionId);
    const helperLog = await log.readTail(helper.sessionId);
    const [requestSent, resultReceived] = askerLog;
    const [requestReceived, resultSent] = helperLog;
    const exchangeId = requestSent!.id;
    expect(replayed).toMatchObject({ replayed: true });
    expect(askerLog.map(shape)).toEqual([
      {
        id: requestSent!.id,
        type: "bot.message.sent",
        parentId: null,
        payload: {
          to: { kind: "bot", botId: helper.bot.id, name: "Analyst" },
          text: "Chart Q3",
          intent: "request",
          hop: 1,
          exchangeId,
        },
      },
      {
        id: resultReceived!.id,
        type: "bot.message.received",
        parentId: requestSent!.id,
        payload: {
          from: { kind: "bot", botId: helper.bot.id, name: "Analyst" },
          fromSessionId: helper.sessionId,
          fromEntryId: resultSent!.id,
          text: "Q3 is up 4%",
          intent: "result",
          hop: 2,
          exchangeId,
          clientNonce: "bot-message:call-2",
        },
      },
    ]);
    expect(helperLog.map(shape)).toEqual([
      {
        id: helperRun.sourceMessageId,
        type: "bot.message.received",
        parentId: null,
        payload: {
          from: { kind: "bot", botId: asker.bot.id, name: "Researcher" },
          fromSessionId: asker.sessionId,
          fromEntryId: requestSent!.id,
          text: "Chart Q3",
          intent: "request",
          hop: 1,
          exchangeId,
          clientNonce: "bot-message:call-1",
        },
      },
      {
        id: resultSent!.id,
        type: "bot.message.sent",
        parentId: requestReceived!.id,
        payload: {
          to: { kind: "bot", botId: asker.bot.id, name: "Researcher" },
          text: "Q3 is up 4%",
          intent: "result",
          hop: 2,
          exchangeId,
        },
      },
    ]);
  });

  it("names a connected agent from another owner as an agent peer on both sides", async () => {
    const { prisma } = database;
    const asker = await seedBot(prisma, "Concierge");
    const helper = await seedBot(prisma, "Partner");
    const askerRun = await seedRun(prisma, asker.bot.id, asker.threadId);
    for (const [bot, address] of [
      [asker.bot, "+15550000001"],
      [helper.bot, "+15550000002"],
    ] as const) {
      await prisma.messagingIdentity.create({
        data: { provider: "sendblue", address, userId: USER, spaceId: SPACE, botId: bot.id },
      });
    }
    await prisma.agentConnection.create({
      data: { requesterBotId: asker.bot.id, targetBotId: helper.bot.id, status: "approved" },
    });
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof messageConnectedAgent>[0];

    await messageConnectedAgent(deps, askerRun, asker.bot, {
      address: "+15550000002",
      message: "Table for two at eight?",
      deliveryKey: "call-agent",
    });

    const [sent] = await log.readTail(asker.sessionId);
    const [received] = await log.readTail(helper.sessionId);
    expect([sent!, received!].map(shape)).toEqual([
      {
        id: sent!.id,
        type: "bot.message.sent",
        parentId: null,
        payload: {
          to: { kind: "agent", address: "+15550000002", name: "Partner" },
          text: "Table for two at eight?",
          intent: "request",
          hop: 1,
          exchangeId: sent!.id,
        },
      },
      {
        id: received!.id,
        type: "bot.message.received",
        parentId: null,
        payload: {
          from: { kind: "agent", address: "+15550000001", name: "Concierge" },
          fromSessionId: asker.sessionId,
          fromEntryId: sent!.id,
          text: "Table for two at eight?",
          intent: "request",
          hop: 1,
          exchangeId: sent!.id,
          clientNonce: "agent-message:call-agent",
        },
      },
    ]);
  });

  it("leaves a result returned after its run ended outside that run", async () => {
    const { prisma } = database;
    const asker = await seedBot(prisma, "Planner");
    const helper = await seedBot(prisma, "Booker");
    const askerRun = await seedRun(prisma, asker.bot.id, asker.threadId);
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof messageBot>[0];
    await messageBot(deps, askerRun, asker.bot, { bot_id: helper.bot.id, message: "Book it" });
    const helperRun = await prisma.run.update({
      where: { id: (await prisma.run.findFirstOrThrow({ where: { botId: helper.bot.id } })).id },
      data: { status: "completed" },
    });

    await returnBotMessageOutcome(deps, helperRun, helper.bot, "Booked.");

    const [, returned] = await log.readTail(helper.sessionId);
    expect(returned).toMatchObject({ type: "bot.message.sent", payload: { intent: "result" } });
    expect(returned).not.toHaveProperty("runId");
  });

  it("rewinds to before the message it cuts, and clears to an empty chain", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Grace");
    const events = createThreadEvents(prisma);
    const send = (text: string) =>
      events.sendUserMessage({
        spaceId: SPACE,
        threadId,
        botId: bot.id,
        userId: USER,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "user",
        createRun: false,
      });
    const kept = await send("Keep this");
    const cut = await send("Edit this");

    await rewindThread(prisma, {
      spaceId: SPACE,
      threadId,
      botId: bot.id,
      messageId: cut.messageId,
    });
    const rewound = await log.readTail(sessionId);
    await clearThread(prisma, { spaceId: SPACE, threadId, botId: bot.id });

    expect(rewound.map(({ id, type, parentId }) => ({ id, type, parentId }))).toEqual([
      { id: kept.messageId, type: "user.message", parentId: null },
      { id: rewound[1]!.id, type: "rewind", parentId: kept.messageId },
    ]);
    expect(
      (await log.readTail(sessionId)).map(({ type, parentId }) => ({ type, parentId })),
    ).toEqual([{ type: "clear", parentId: null }]);
  });

  it("marks the clear an edit of the first message writes as an edit, and leaves a real clear plain", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Hopper");
    const target = { spaceId: SPACE, threadId, botId: bot.id };
    const first = await createThreadEvents(prisma).sendUserMessage({
      ...target,
      userId: USER,
      blocks: [{ kind: "text", text: "Edit me" }],
      prompt: "Edit me",
      trigger: "user",
      createRun: false,
    });

    await rewindThread(prisma, { ...target, messageId: first.messageId });
    const edited = await log.readTail(sessionId);
    await clearThread(prisma, target);

    expect(edited.map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "clear", payload: { edit: true } },
    ]);
    expect((await log.readTail(sessionId)).map(({ type, payload }) => ({ type, payload }))).toEqual(
      [{ type: "clear", payload: {} }],
    );
  });

  it("ends the history generation at a clear, and at a rewind only when it cuts a turn a compaction summarized", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Ada");
    const events = createThreadEvents(prisma);
    const send = async (text: string) =>
      (
        await events.sendUserMessage({
          spaceId: SPACE,
          threadId,
          botId: bot.id,
          userId: USER,
          blocks: [{ kind: "text", text }],
          prompt: text,
          trigger: "user",
          createRun: false,
        })
      ).messageId;
    const compact = (head: string, summary: string, coveredUpToSeq: number) =>
      prisma.$transaction((tx) =>
        appendSessionEntryInTransaction(tx, {
          type: "compaction",
          sessionId,
          parentId: EntryId.parse(head),
          feedBotId: bot.id,
          payload: { summary, coveredUpToSeq: EntrySeq.parse(coveredUpToSeq) },
        }),
      );
    await send("a");
    await compact(await send("b"), "C1", 0);
    const c = await send("c");
    await send("d");
    const e = await send("e");
    await compact(e, "C2", 3);
    await send("f");
    const target = { spaceId: SPACE, threadId, botId: bot.id };

    const keepsSummarized = await rewindThread(prisma, { ...target, messageId: e });
    const keptTail = await log.readTail(sessionId);
    const cutsSummarized = await rewindThread(prisma, { ...target, messageId: c });
    const cutTail = await log.readTail(sessionId);
    const firstClear = await clearThread(prisma, target);
    const secondClear = await clearThread(prisma, target);

    const shown = (tail: readonly SessionEntry[]) =>
      tail.map((entry) =>
        entry.type === "compaction"
          ? entry.payload.summary
          : entry.type === "user.message"
            ? entry.payload.blocks
                .map((block) => (block.kind === "text" ? block.text : ""))
                .join("")
            : entry.type,
      );
    expect([shown(keptTail), shown(cutTail)]).toEqual([
      ["C2", "d", "rewind"],
      ["C1", "b", "rewind"],
    ]);
    expect([
      keepsSummarized?.historyGeneration,
      cutsSummarized?.historyGeneration,
      firstClear.historyGeneration,
      secondClear.historyGeneration,
    ]).toEqual([undefined, 0, 10, 11]);
  });

  it("keeps a routine run's steps in its own session and its approval and ends in the thread's", async () => {
    const { prisma } = database;
    const hopper = await seedBot(prisma, "Hopper");
    const { sessionId } = hopper;
    const usage = { inputTokens: 0, outputTokens: 0 };

    const digest = await routineRun(prisma, hopper, "Digest");
    await digest.write({
      type: "tool.call",
      payload: { callId: "call_0", name: "spawn_bot", input: "{}" },
    });
    await digest.write({
      type: "effect.requested",
      payload: { effectId: "effect_1", effectKind: "spawn_bot", proposal: { name: "Scout" } },
    });
    await digest.write({
      type: "effect.resolved",
      payload: { effectId: "effect_1", decision: "approved" },
    });
    await digest.write({
      type: "tool.result",
      payload: { callId: "call_0", output: "created", isError: false, artifactIds: [] },
    });
    await digest.write({
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: "Scout is up." }] },
    });
    await prisma.run.update({ where: { id: digest.run.id }, data: { status: "completed" } });
    await prisma.$transaction((tx) =>
      appendRunFinishedInTransaction(
        tx,
        digest.run.id,
        { status: "completed" },
        { result: "Scout is up." },
      ),
    );
    const stopped = await routineRun(prisma, hopper, "Tidy");
    await prisma.$transaction((tx) =>
      cancelRunsInTransaction(
        tx,
        [{ id: stopped.run.id, taskId: stopped.run.taskId }],
        new Date(),
        USER,
      ),
    );

    expect(await types(digest.routineSessionId)).toEqual([
      "run.started",
      "tool.call",
      "tool.result",
      "assistant.text",
      "run.finished",
    ]);
    expect(await types(stopped.routineSessionId)).toEqual(["run.started", "run.finished"]);
    expect(
      (await log.readTail(sessionId)).map(({ type, runId, payload }) => ({ type, runId, payload })),
    ).toEqual([
      {
        type: "routine.started",
        runId: digest.run.id,
        payload: {
          sessionId: digest.routineSessionId,
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: SCHEDULED_AT,
          model: SCRIPTED,
        },
      },
      {
        type: "effect.requested",
        runId: digest.run.id,
        payload: {
          effectId: "effect_1",
          effectKind: "spawn_bot",
          proposal: { name: "Scout" },
          originSessionId: digest.routineSessionId,
        },
      },
      {
        type: "effect.resolved",
        runId: digest.run.id,
        payload: {
          effectId: "effect_1",
          decision: "approved",
          originSessionId: digest.routineSessionId,
        },
      },
      {
        type: "routine.finished",
        runId: digest.run.id,
        payload: { status: "completed", usage, result: "Scout is up." },
      },
      {
        type: "routine.started",
        runId: stopped.run.id,
        payload: expect.objectContaining({ sessionId: stopped.routineSessionId, name: "Tidy" }),
      },
      {
        type: "routine.finished",
        runId: stopped.run.id,
        payload: { status: "cancelled", by: USER, usage, result: "" },
      },
    ]);
  });

  it("forwards a routine run's question, its choice and the person's answer to the thread's session", async () => {
    const { prisma } = database;
    const grace = await seedBot(prisma, "Grace");
    const { run, routineSessionId } = await routineRun(prisma, grace, "Inbox");
    const askId = EntryId.parse(randomUUID());

    await prisma.$transaction((tx) =>
      appendRunBlocksInTransaction(tx, { id: askId, runId: run.id, botId: grace.bot.id }, [
        { kind: "ask", text: "Which inbox?" },
        {
          kind: "choice",
          question: "Archive the rest?",
          options: [{ id: "yes", letter: "A", label: "Yes" }],
        },
      ]),
    );
    await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        type: "user.message",
        sessionId: routineSessionId,
        feedBotId: grace.bot.id,
        payload: {
          blocks: [{ kind: "text", text: "Work" }],
          replyTo: { entryId: askId },
          source: "app",
        },
      }),
    );

    expect(await types(routineSessionId)).toEqual(["run.started"]);
    expect(await origins(grace.sessionId)).toEqual([
      ["routine.started", undefined],
      ["assistant.ask", routineSessionId],
      ["assistant.choice", routineSessionId],
      ["user.message", routineSessionId],
    ]);
  });

  it("raises a routine's MCP approval card to the thread's session whole and keeps its chart", async () => {
    const { prisma } = database;
    const franklin = await seedBot(prisma, "Franklin");
    const { run, routineSessionId, write } = await routineRun(prisma, franklin, "Veille presse");
    const approval = {
      kind: "mcp_approval",
      name: "Press",
      serverId: "mcp_press",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test",
      needsOAuth: true,
    } as const;
    const chart: MessageBlock = { kind: "chart", name: "Mentions", spec: {}, data: [] };

    await prisma.$transaction((tx) =>
      appendRunBlocksInTransaction(
        tx,
        { id: EntryId.parse(randomUUID()), runId: run.id, botId: franklin.bot.id },
        [approval, chart],
      ),
    );
    const asked = [{ kind: "text", text: "Connect the press server?" }, approval];
    await write({ type: "assistant.text", payload: { blocks: asked } });

    const blocksOf = async (sessionId: SessionId) =>
      (await log.readTail(sessionId)).map(({ type, payload }) => ({
        type,
        blocks: "blocks" in payload ? payload.blocks : undefined,
      }));
    expect(await blocksOf(routineSessionId)).toEqual([
      { type: "run.started", blocks: undefined },
      { type: "assistant.text", blocks: [chart] },
    ]);
    expect(await blocksOf(franklin.sessionId)).toEqual([
      { type: "routine.started", blocks: undefined },
      { type: "assistant.text", blocks: [approval] },
      { type: "assistant.text", blocks: asked },
    ]);
  });

  it.each<[string, MessageBlock]>([
    [
      "an app to connect",
      {
        kind: "app_connect",
        provider: "gmail",
        name: "Gmail",
        description: "Read your inbox",
        logo: null,
        status: "pending",
      },
    ],
    ["a card", { kind: "card", lines: [{ k: "Invoice", v: "Due Friday" }] }],
  ])(
    "marks %s a routine run shows for the person, in the thread's session",
    async (name, connect) => {
      const { prisma } = database;
      const ada = await seedBot(prisma, `Ada (${name})`);
      const { run, routineSessionId } = await routineRun(prisma, ada, `Inbox sweep ${name}`);

      await prisma.$transaction((tx) =>
        appendRunBlocksInTransaction(
          tx,
          { id: EntryId.parse(randomUUID()), runId: run.id, botId: ada.bot.id },
          [{ kind: "text", text: "Sweeping." }, connect],
        ),
      );

      const written = async (sessionId: SessionId) =>
        (await log.readTail(sessionId)).map(({ type, payload }) => ({ type, payload }));
      expect(await written(routineSessionId)).toEqual([
        expect.objectContaining({ type: "run.started" }),
        { type: "assistant.text", payload: { blocks: [{ kind: "text", text: "Sweeping." }] } },
      ]);
      expect(await written(ada.sessionId)).toEqual([
        expect.objectContaining({ type: "routine.started" }),
        {
          type: "assistant.text",
          payload: { blocks: [connect], toPerson: true, originSessionId: routineSessionId },
        },
      ]);
    },
  );

  it("shows the card of a peer run the thread hides", async () => {
    const { prisma } = database;
    const ida = await seedBot(prisma, "Ida");
    const run = await seedRun(prisma, ida.bot.id, ida.threadId, { trigger: "bot_message" });
    const card: MessageBlock = {
      kind: "app_connect",
      provider: "quickbooks",
      name: "QuickBooks",
      description: "Read your invoices",
      logo: null,
      status: "pending",
    };

    await prisma.$transaction((tx) =>
      appendRunBlocksInTransaction(
        tx,
        { id: EntryId.parse(randomUUID()), runId: run.id, botId: ida.bot.id },
        [{ kind: "text", text: "Checked with the ledger bot." }, card],
      ),
    );

    const shown = visibleEntries(await log.readTail(ida.sessionId), {
      hiddenPeerRunIds: new Set([run.id]),
    });
    expect(
      projectThreadItems(shown).flatMap((item) => (item.kind === "message" ? item.blocks : [])),
    ).toEqual([card]);
  });

  it("raises a helper's question and its approval request to the thread's session and keeps its steps", async () => {
    const { prisma } = database;
    const noether = await seedBot(prisma, "Noether");
    const parent = await seedRun(prisma, noether.bot.id, noether.threadId);
    const helper = await subagentRun(prisma, parent);
    const ask = (runId: string, text: string) =>
      prisma.$transaction((tx) =>
        appendRunBlocksInTransaction(
          tx,
          { id: EntryId.parse(randomUUID()), runId, botId: noether.bot.id },
          [{ kind: "ask", text }],
        ),
      );

    await ask(helper.run.id, "Which file?");
    await helper.write({
      type: "effect.requested",
      payload: { effectId: "effect_helper", effectKind: "spawn_bot", proposal: { name: "Scout" } },
    });
    await ask(parent.id, "Anything else?");

    expect(await types(helper.sessionId)).toEqual(["run.started"]);
    expect(await origins(noether.sessionId)).toEqual([
      ["tool.call", undefined],
      ["assistant.ask", helper.sessionId],
      ["effect.requested", helper.sessionId],
      ["assistant.ask", undefined],
    ]);
  });

  it("raises a question from a helper a routine started past the routine, to the thread's session", async () => {
    const { prisma } = database;
    const meitner = await seedBot(prisma, "Meitner");
    const routine = await routineRun(prisma, meitner, "Veille presse");
    const helper = await subagentRun(prisma, routine.run);

    await prisma.$transaction((tx) =>
      appendRunBlocksInTransaction(
        tx,
        { id: EntryId.parse(randomUUID()), runId: helper.run.id, botId: meitner.bot.id },
        [{ kind: "ask", text: "Which outlets?" }],
      ),
    );

    expect(await types(helper.sessionId)).toEqual(["run.started"]);
    expect(await types(routine.routineSessionId)).toEqual(["run.started", "tool.call"]);
    expect(await origins(meitner.sessionId)).toEqual([
      ["routine.started", undefined],
      ["assistant.ask", helper.sessionId],
    ]);
  });

  it("opens two interactive sessions, persists source anchors and raises only explicit user messages", async () => {
    const { prisma } = database;
    const owner = await seedBot(prisma, "Interactive");
    const source = await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: owner.threadId,
        role: "user",
        blocks: [{ kind: "text", text: "Find the answer" }],
      }),
    );
    const first = await seedRun(prisma, owner.bot.id, owner.threadId);
    await prisma.run.update({ where: { id: first.id }, data: { sourceMessageId: source.id } });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: first.id } });
    const open = () =>
      openRunLog(
        { prisma, sessionLog: log },
        run,
        { sessionId: owner.sessionId, runId: run.id, botId: owner.bot.id },
        SCRIPTED,
        null,
      );
    const opened = await open();
    const again = await open();
    expect(again.sessionId).toBe(opened.sessionId);
    expect(
      await prisma.conversationSession.findUnique({ where: { id: opened.sessionId } }),
    ).toMatchObject({
      kind: "interactive",
      parentSessionId: owner.sessionId,
      parentEntryId: source.id,
      threadId: null,
    });
    const write = writerOf(prisma, run);
    await write({ type: "assistant.reasoning", payload: { text: "Private deliberation" } });
    await write({
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: "Private text" }] },
    });
    await prisma.$transaction((tx) =>
      createBotMessageInTransaction(tx, {
        threadId: owner.threadId,
        botId: owner.bot.id,
        runId: run.id,
        blocks: [{ kind: "text", text: "The answer is 42." }],
        toPerson: true,
        midTurn: true,
      }),
    );
    const second = await seedRun(prisma, owner.bot.id, owner.threadId);
    const next = await openRunLog(
      { prisma, sessionLog: log },
      second,
      { sessionId: owner.sessionId, runId: second.id, botId: owner.bot.id },
      SCRIPTED,
      null,
    );
    expect(next.sessionId).not.toBe(opened.sessionId);
    const nextSession = await prisma.conversationSession.findUniqueOrThrow({
      where: { id: next.sessionId },
    });
    expect(nextSession).toMatchObject({ kind: "interactive", parentSessionId: owner.sessionId });
    expect(
      await log.readEntry(owner.sessionId, EntryId.parse(nextSession.parentEntryId)),
    ).toMatchObject({
      type: "run.opened",
      payload: { sessionId: next.sessionId },
    });
    const main = await log.readTail(owner.sessionId);
    expect(
      projectThreadItems(main).filter((item) => item.kind === "message" && item.role === "bot"),
    ).toEqual([
      expect.objectContaining({
        blocks: [{ kind: "text", text: "The answer is 42." }],
        origin: { sessionId: opened.sessionId },
      }),
    ]);
    expect(JSON.stringify(main)).not.toContain("Private deliberation");
    expect(JSON.stringify(main)).not.toContain("Private text");
    expect(await types(opened.sessionId)).toEqual([
      "run.started",
      "assistant.reasoning",
      "assistant.text",
    ]);
  });

  it.each([
    "available",
    "absent",
    "foreign",
    "reasoning",
    "unanswered",
    "reused-unanswered",
    "reused-answered",
    "reused-overlapped",
    "rewound",
    "failed",
    "cancelled",
  ] as const)(
    "durably closes an interactive run once with a truthful %s recap and no user bubble",
    async (scenario) => {
      const { prisma } = database;
      const owner = await seedBot(prisma, `Recap ${scenario}`);
      const lease = { leaseOwner: "worker-1", leaseFence: 1 };
      const run = await seedRun(prisma, owner.bot.id, owner.threadId, lease);
      const opened = await openRunLog(
        { prisma, sessionLog: log },
        run,
        { sessionId: owner.sessionId, runId: run.id, botId: owner.bot.id },
        SCRIPTED,
        null,
      );
      const write = writerOf(prisma, run);
      const call = await write({
        type: "tool.call",
        payload: { callId: "lookup", name: "list_files", input: "{}" },
      });
      const result = await write({
        type: "tool.result",
        payload: { callId: "lookup", output: "Found report.txt", isError: false, artifactIds: [] },
      });
      const reasoning = await write({
        type: "assistant.reasoning",
        payload: { text: "Private reasoning" },
      });
      if (scenario === "unanswered")
        await write({
          type: "tool.call",
          payload: { callId: "pending", name: "list_files", input: "{}" },
        });
      const repeated = scenario.startsWith("reused-")
        ? await write({
            type: "tool.call",
            payload: { callId: "lookup", name: "list_files", input: '{"path":"other"}' },
          })
        : undefined;
      if (scenario === "reused-overlapped")
        await write({
          type: "tool.call",
          payload: { callId: "lookup", name: "list_files", input: '{"path":"replay"}' },
        });
      if (scenario === "reused-answered" || scenario === "reused-overlapped")
        await write({
          type: "tool.result",
          payload: { callId: "lookup", output: "Found other.txt", isError: false, artifactIds: [] },
        });
      if (scenario === "rewound")
        await prisma.$transaction((tx) =>
          log.append(tx, {
            type: "rewind",
            sessionId: opened.sessionId,
            parentId: call.id,
            botId: owner.bot.id,
            payload: {},
          }),
        );
      const recap: FactualRunRecap | undefined =
        scenario === "absent"
          ? undefined
          : {
              state: "available",
              facts: {
                version: 1,
                results: ["Found report.txt"],
                references:
                  scenario === "foreign"
                    ? [{ entryId: EntryId.parse("not-this-run") }]
                    : scenario === "reasoning"
                      ? [{ entryId: reasoning.id }]
                      : scenario === "unanswered"
                        ? [{ callId: "pending" }]
                        : repeated
                          ? [{ entryId: repeated.id }, { entryId: result.id }, { callId: "lookup" }]
                          : [{ callId: "lookup" }, { entryId: result.id }],
              },
            };
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      const close = () =>
        scenario === "cancelled"
          ? prisma.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date()))
          : finalizeRun(prisma, {
              spaceId: SPACE,
              threadId: owner.threadId,
              botId: owner.bot.id,
              runId: run.id,
              taskId: run.taskId,
              attemptId: attempt.id,
              ...lease,
              recap,
              ...(scenario === "failed"
                ? { outcome: "failed" as const, error: "Connection interrupted" }
                : { outcome: "completed" as const, blocks: [], markUnread: false }),
            });
      await close();
      await close();
      const main = await log.readTail(owner.sessionId);
      const recaps = main.filter((entry) => entry.type === "run.recap");
      const expected =
        scenario === "available" || scenario === "reused-answered"
          ? recap
          : {
              state: "missing",
              reason:
                scenario === "absent"
                  ? "absent"
                  : scenario === "failed" || scenario === "cancelled"
                    ? "interrupted"
                    : "invalid_reference",
            };
      expect(recaps).toEqual([
        expect.objectContaining({
          runId: run.id,
          payload: {
            version: 1,
            sessionId: opened.sessionId,
            outcome: expect.objectContaining({
              status: scenario === "failed" || scenario === "cancelled" ? scenario : "completed",
            }),
            recap: expected,
          },
        }),
      ]);
      expect(await types(opened.sessionId)).toContain("run.finished");
      expect(
        (await log.readTail(opened.sessionId)).filter((entry) => entry.type === "run.finished"),
      ).toHaveLength(1);
      expect(projectThreadItems(main)).toEqual([]);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: owner.threadId } })).unread,
      ).toBe(false);
    },
  );

  it.each(["question", "approval"] as const)(
    "clears an interactive %s waiting target after cancellation and reload",
    async (kind) => {
      const { prisma } = database;
      const owner = await seedBot(prisma, `Cancelled ${kind}`);
      const lease = { leaseOwner: "worker-1", leaseFence: 1 };
      const run = await seedRun(prisma, owner.bot.id, owner.threadId, lease);
      const opened = await openRunLog(
        { prisma, sessionLog: log },
        run,
        { sessionId: owner.sessionId, runId: run.id, botId: owner.bot.id },
        SCRIPTED,
        null,
      );
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      const card: MessageBlock =
        kind === "question"
          ? { kind: "ask", text: "Which report?" }
          : spawnBotApprovalBlock(
              "effect-cancelled",
              { name: "Scout", instructions: "Read reports." },
              USER,
            );
      await pauseRunForInput(prisma, {
        spaceId: SPACE,
        threadId: owner.threadId,
        botId: owner.bot.id,
        runId: run.id,
        attemptId: attempt.id,
        ...lease,
        blocks: [card],
        ...(kind === "approval"
          ? { effect: { id: "effect-cancelled", kind: "spawn_bot", proposal: { name: "Scout" } } }
          : {}),
      });
      const before = projectThreadView(await log.readTail(owner.sessionId));
      expect(before.waiting).toEqual({
        runId: run.id,
        entryId: expect.any(String),
        itemId: expect.any(String),
      });
      await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date(), USER));
      const parent = await log.readTail(owner.sessionId);
      expect(parent.filter((entry) => entry.type === "run.recap")).toEqual([
        expect.objectContaining({
          runId: run.id,
          payload: expect.objectContaining({
            outcome: expect.objectContaining({ status: "cancelled" }),
          }),
        }),
      ]);
      expect((await log.readTail(opened.sessionId)).at(-1)).toMatchObject({ type: "run.finished" });
      const reloaded = projectThreadView(parent);
      expect(reloaded.rows).toEqual(before.rows);
      expect(reloaded.waiting).toBeNull();
    },
  );

  it("indexes a run cancelled before its execution session opens without inventing a completed log", async () => {
    const { prisma } = database;
    const owner = await seedBot(prisma, "Cancelled before start");
    const run = await seedRun(prisma, owner.bot.id, owner.threadId);
    await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date()));
    await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [run], new Date()));
    const main = await log.readTail(owner.sessionId);
    expect(main).toEqual([
      expect.objectContaining({
        type: "run.recap",
        runId: run.id,
        payload: {
          version: 1,
          sessionId: owner.sessionId,
          outcome: { status: "cancelled", usage: { inputTokens: 0, outputTokens: 0 } },
          recap: { state: "missing", reason: "interrupted" },
        },
      }),
    ]);
    expect(projectThreadItems(main)).toEqual([]);
  });

  it.each([true, false])(
    "claims steering once across interactive finalization, claimed before finish %s",
    async (claimBeforeFinish) => {
      const { prisma } = database;
      const owner = await seedBot(prisma, `Steering ${claimBeforeFinish}`);
      const lease = { leaseOwner: "worker-1", leaseFence: 1 };
      const run = await seedRun(prisma, owner.bot.id, owner.threadId, lease);
      const opened = await openRunLog(
        { prisma, sessionLog: log },
        run,
        { sessionId: owner.sessionId, runId: run.id, botId: owner.bot.id },
        SCRIPTED,
        null,
      );
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      const events = createThreadEvents(prisma);
      const sent = await events.sendUserMessage({
        spaceId: SPACE,
        botId: owner.bot.id,
        userId: USER,
        threadId: owner.threadId,
        blocks: [{ kind: "text", text: "Use the updated date" }],
        prompt: "Use the updated date",
        trigger: "follow_up",
      });
      const fence = {
        threadId: owner.threadId,
        botId: owner.bot.id,
        runId: run.id,
        ...lease,
        seenIds: [],
      };
      if (claimBeforeFinish) {
        const claimed = await events.claimSteering(fence);
        expect(claimed).toEqual([
          expect.objectContaining({ messageId: sent.messageId, text: "Use the updated date" }),
        ]);
        expect(
          await events.claimSteering({ ...fence, seenIds: claimed.map((item) => item.id) }),
        ).toEqual([]);
      }
      const terminal = await events.finalizeRun({
        spaceId: SPACE,
        threadId: owner.threadId,
        botId: owner.bot.id,
        runId: run.id,
        taskId: run.taskId,
        attemptId: attempt.id,
        ...lease,
        outcome: "completed",
        blocks: [],
        markUnread: false,
      });
      expect(terminal).toEqual({
        continuationRunId: claimBeforeFinish ? null : expect.any(String),
      });
      expect(await events.claimSteering(fence)).toEqual([]);
      if (!claimBeforeFinish && terminal) {
        const continuation = await prisma.run.update({
          where: { id: terminal.continuationRunId! },
          data: { status: "running", ...lease },
        });
        const next = await openRunLog(
          { prisma, sessionLog: log },
          continuation,
          { sessionId: owner.sessionId, runId: continuation.id, botId: owner.bot.id },
          SCRIPTED,
          null,
        );
        expect(next.sessionId).not.toBe(opened.sessionId);
        const continuationFence = { ...fence, runId: continuation.id };
        const claimed = await events.claimSteering(continuationFence);
        expect(claimed).toEqual([expect.objectContaining({ messageId: sent.messageId })]);
        expect(
          await events.claimSteering({
            ...continuationFence,
            seenIds: claimed.map((item) => item.id),
          }),
        ).toEqual([]);
      }
      expect(
        (await log.readTail(owner.sessionId)).filter((entry) => entry.type === "user.message"),
      ).toEqual([expect.objectContaining({ id: sent.messageId })]);
    },
  );

  it.each(["messaging", "follow_up"])(
    "keeps %s channel work in the existing main session",
    async (trigger) => {
      const { prisma } = database;
      const owner = await seedBot(prisma, `Channel ${trigger}`);
      const source = await prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: owner.threadId,
          role: "user",
          blocks: [
            {
              kind: "channel_message",
              provider: "imessage",
              channelId: "channel-1",
              fromAddress: "+10000000000",
              fromLabel: "Fixture",
              text: "Channel request",
            },
          ],
        }),
      );
      const queued = await seedRun(prisma, owner.bot.id, owner.threadId, { trigger });
      const run = await prisma.run.update({
        where: { id: queued.id },
        data: { sourceMessageId: source.id },
      });
      const opened = await openRunLog(
        { prisma, sessionLog: log },
        run,
        { sessionId: owner.sessionId, runId: run.id, botId: owner.bot.id },
        SCRIPTED,
        null,
      );
      expect(opened.sessionId).toBe(owner.sessionId);
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).sessionId).toBe(
        owner.sessionId,
      );
      expect(
        await prisma.conversationSession.count({
          where: { parentSessionId: owner.sessionId, kind: "interactive" },
        }),
      ).toBe(0);
      expect(await types(owner.sessionId)).toEqual(["user.message", "run.started"]);
    },
  );

  it("opens a webhook routine run's own session once, and a resumed run reopens that one", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Turing");
    const routine = await prisma.routine.create({
      data: {
        spaceId: SPACE,
        botId: bot.id,
        userId: USER,
        threadId,
        name: "Deploy hook",
        prompt: "Ship it.",
        crons: [],
        webhookEnabled: true,
      },
    });
    const queued = await seedRun(prisma, bot.id, threadId, {
      trigger: "webhook",
      routineId: routine.id,
    });
    const open = async () => {
      const run = await prisma.run.findUniqueOrThrow({ where: { id: queued.id } });
      const runLog = { sessionId: run.sessionId as SessionId, runId: run.id, botId: bot.id };
      return openRunLog({ prisma, sessionLog: log }, run, runLog, SCRIPTED, null);
    };

    const opened = await open();
    await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        type: "tool.call",
        sessionId: opened.sessionId,
        botId: bot.id,
        runId: queued.id,
        payload: { callId: "call_0", name: "deploy", input: "{}" },
      }),
    );
    const resumed = await open();

    expect(resumed).toEqual({
      sessionId: opened.sessionId,
      awaitingResult: new Map([["call_0", "{}"]]),
    });
    expect((await log.readTail(sessionId)).map(({ type, payload }) => ({ type, payload }))).toEqual(
      [
        {
          type: "routine.started",
          payload: {
            sessionId: opened.sessionId,
            routineId: routine.id,
            name: "Deploy hook",
            trigger: "webhook",
            scheduledAt: queued.createdAt.toISOString(),
            model: SCRIPTED,
          },
        },
      ],
    );
    expect(
      (await log.readTail(opened.sessionId)).map(({ type, payload }) => ({ type, payload })),
    ).toEqual([
      {
        type: "run.started",
        payload: {
          trigger: { kind: "webhook", routineId: routine.id },
          model: SCRIPTED,
          effort: null,
        },
      },
      { type: "tool.call", payload: { callId: "call_0", name: "deploy", input: "{}" } },
    ]);
  });

  it("marks the start of a routine the person subscribed to as one to notify", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Lamarr");
    const routine = await prisma.routine.create({
      data: {
        spaceId: SPACE,
        botId: bot.id,
        userId: USER,
        threadId,
        name: "Release watch",
        prompt: "Tell me when it ships.",
        crons: [],
        webhookEnabled: true,
        notify: true,
      },
    });
    const run = await seedRun(prisma, bot.id, threadId, {
      trigger: "webhook",
      routineId: routine.id,
    });

    const opened = await openRunLog(
      { prisma, sessionLog: log },
      run,
      { sessionId, runId: run.id, botId: bot.id },
      SCRIPTED,
      null,
    );

    expect((await log.readTail(sessionId)).map(({ type, payload }) => ({ type, payload }))).toEqual(
      [
        {
          type: "routine.started",
          payload: {
            sessionId: opened.sessionId,
            routineId: routine.id,
            name: "Release watch",
            trigger: "webhook",
            scheduledAt: run.createdAt.toISOString(),
            model: SCRIPTED,
            notify: true,
          },
        },
      ],
    );
  });

  it("reports a routine run that fails through finalizeRun as failed in the thread's session", async () => {
    const { prisma } = database;
    const lovelace = await seedBot(prisma, "Lovelace");
    const lease = { leaseOwner: "worker-1", leaseFence: 1 };
    const { run, routineSessionId } = await routineRun(prisma, lovelace, "Digest", lease);
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: lease.leaseFence, status: "running" },
    });

    await finalizeRun(prisma, {
      spaceId: SPACE,
      threadId: lovelace.threadId,
      botId: lovelace.bot.id,
      runId: run.id,
      taskId: run.taskId,
      attemptId: attempt.id,
      ...lease,
      outcome: "failed",
      error: "model unavailable",
    });

    expect(await types(routineSessionId)).toEqual(["run.started", "run.finished"]);
    expect(
      (await log.readTail(lovelace.sessionId)).map(({ type, payload }) => ({ type, payload })),
    ).toEqual([
      expect.objectContaining({ type: "routine.started" }),
      {
        type: "routine.finished",
        payload: {
          status: "failed",
          error: "model unavailable",
          usage: { inputTokens: 0, outputTokens: 0 },
          result: "",
        },
      },
    ]);
  });

  it("names the thread's session, not the routine's, as where a routine run's bot message came from", async () => {
    const { prisma } = database;
    const asker = await seedBot(prisma, "Babbage");
    const helper = await seedBot(prisma, "Clarke");
    const { run, routineSessionId } = await routineRun(prisma, asker, "Digest");
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof messageBot>[0];

    await messageBot(deps, run, asker.bot, {
      bot_id: helper.bot.id,
      message: "Chart Q3",
      deliveryKey: "routine-call-1",
    });

    const [sent] = await log.readTail(asker.sessionId).then((entries) => entries.slice(-1));
    const [received] = await log.readTail(helper.sessionId);
    expect(await types(routineSessionId)).toEqual(["run.started"]);
    expect([sent?.type, received?.type, received?.payload]).toEqual([
      "bot.message.sent",
      "bot.message.received",
      expect.objectContaining({ fromSessionId: asker.sessionId, fromEntryId: sent?.id }),
    ]);
  });

  it("closes the log of a run it cancels with who cancelled it", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Linus");
    const run = await seedRun(prisma, bot.id, threadId);
    await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        type: "run.started",
        sessionId,
        botId: bot.id,
        runId: run.id,
        payload: {
          trigger: { kind: "direct" },
          model: { provider: "scripted", id: "scripted" },
          effort: null,
        },
      }),
    );

    await clearThread(prisma, { spaceId: SPACE, threadId, botId: bot.id, userId: USER });

    expect((await log.readRun(run.id)).map(({ type, payload }) => ({ type, payload }))).toEqual([
      {
        type: "run.started",
        payload: {
          trigger: { kind: "direct" },
          model: { provider: "scripted", id: "scripted" },
          effort: null,
        },
      },
      {
        type: "run.finished",
        payload: { status: "cancelled", by: USER, usage: { inputTokens: 0, outputTokens: 0 } },
      },
    ]);
  });

  describe("a run's learnt skills", () => {
    const text = (value: string): MessageBlock[] => [{ kind: "text", text: value }];
    const lineDeps = () => ({
      prisma: database.prisma,
      events: { notify: vi.fn(async () => undefined) },
      sessionLog: log,
      lineOnlyMessages: true,
    });
    const learnt = async (sessionId: SessionId) =>
      (await log.readTail(sessionId)).flatMap((entry) =>
        entry.type === "skill.learnt" ? [{ runId: entry.runId, ...entry.payload }] : [],
      );
    const wrote = (runId: string, kind: string, name: string) =>
      database.prisma.externalEffect.create({
        data: {
          spaceId: SPACE,
          runId,
          kind,
          idempotencyKey: randomUUID(),
          status: "completed",
          request: {},
          result: { ok: true, name },
        },
      });
    const replied = (run: { id: string; botId: string; threadId: string }, value: string) =>
      database.prisma.$transaction((tx) =>
        createBotMessageInTransaction(tx, {
          threadId: run.threadId,
          botId: run.botId,
          runId: run.id,
          blocks: text(value),
        }),
      );
    const ended = (runId: string, status = "completed") =>
      database.prisma.run.update({ where: { id: runId }, data: { status } });

    it("logs each skill once, with its line under the reply, however often the lines are written", async () => {
      const { prisma } = database;
      const { bot, threadId, sessionId } = await seedBot(prisma, "Ines");
      const run = await seedRun(prisma, bot.id, threadId);
      await replied(run, "Done.");
      await wrote(run.id, "skill_create", "Coffee");
      await wrote(run.id, "skill_create", "Tea");
      await wrote(run.id, "skill_update", "Coffee");
      await ended(run.id);

      await writeSkillLines(lineDeps(), run.id);
      await writeSkillLines(lineDeps(), run.id);

      expect(await learnt(sessionId)).toEqual([
        { runId: run.id, skillId: "user:coffee", name: "Coffee", change: "learned" },
        { runId: run.id, skillId: "user:tea", name: "Tea", change: "learned" },
      ]);
    });

    it("lands a routine run's skill in the thread's session, naming the routine's", async () => {
      const { prisma } = database;
      const seeded = await seedBot(prisma, "Olga");
      const { run, routineSessionId } = await routineRun(prisma, seeded, "Digest", {
        trigger: "routine",
      });
      await replied(run, "Digest sent.");
      await wrote(run.id, "skill_create", "Digest");
      await ended(run.id);

      await writeSkillLines(lineDeps(), run.id);

      expect(await learnt(seeded.sessionId)).toEqual([
        {
          runId: run.id,
          originSessionId: routineSessionId,
          skillId: "user:digest",
          name: "Digest",
          change: "learned",
        },
      ]);
      expect(await learnt(routineSessionId)).toEqual([]);
    });

    it("lands the skill of a run nobody started in the bot's own thread when the line goes there", async () => {
      const { prisma } = database;
      const seeded = await seedBot(prisma, "Pia");
      const group = await prisma.chatGroup.create({
        data: { spaceId: SPACE, userId: USER, name: "Team" },
      });
      const groupThread = await prisma.thread.create({
        data: { spaceId: SPACE, userId: USER, groupId: group.id },
      });
      const run = await seedRun(prisma, seeded.bot.id, groupThread.id, { trigger: "routine" });
      await prisma.skillSetting.create({
        data: { spaceId: SPACE, userId: USER, skillKey: "user:shared", availability: "all" },
      });
      await wrote(run.id, "skill_update", "Shared");
      await ended(run.id);

      await writeSkillLines(lineDeps(), run.id);

      expect(await learnt(seeded.sessionId)).toEqual([
        { runId: run.id, skillId: "user:shared", name: "Shared", change: "updated" },
      ]);
      expect(await learnt(groupThread.sessionId as SessionId)).toEqual([]);
    });

    it("logs the skills of a run cancelled after it saved them", async () => {
      const { prisma } = database;
      const { bot, threadId, sessionId } = await seedBot(prisma, "Rita");
      const run = await seedRun(prisma, bot.id, threadId);
      await wrote(run.id, "skill_create", "Soup");
      await ended(run.id, "cancelled");

      await writeSkillLines(lineDeps(), run.id);

      expect(await learnt(sessionId)).toEqual([
        { runId: run.id, skillId: "user:soup", name: "Soup", change: "learned" },
      ]);
    });

    describe("in a conversation the person emptied since", () => {
      const later = () => new Date(Date.now() + 10 * 60_000);
      const emptied = async (
        name: string,
        status: string,
        {
          replies = true,
          startedFirst = false,
        }: { replies?: boolean; startedFirst?: boolean } = {},
      ) => {
        const { prisma } = database;
        const seeded = await seedBot(prisma, name);
        const earlyRun = startedFirst
          ? await seedRun(prisma, seeded.bot.id, seeded.threadId)
          : undefined;
        const ask = await createThreadEvents(prisma).sendUserMessage({
          spaceId: SPACE,
          threadId: seeded.threadId,
          botId: seeded.bot.id,
          userId: USER,
          blocks: text("Order my coffee."),
          prompt: "Order my coffee.",
          trigger: "user",
          createRun: false,
        });
        const run = earlyRun ?? (await seedRun(prisma, seeded.bot.id, seeded.threadId));
        if (replies) await replied(run, "Done.");
        await wrote(run.id, "skill_create", "Coffee");
        await ended(run.id, status);
        const thread = { spaceId: SPACE, threadId: seeded.threadId, botId: seeded.bot.id };
        const nothingCameBack = async () => {
          await createSkillLineSweep(lineDeps(), { now: later })();
          expect(await learnt(seeded.sessionId)).toEqual([]);
        };
        return { run, thread, ask, nothingCameBack };
      };

      it("gets no line back after a clear", async () => {
        const { thread, nothingCameBack } = await emptied("Sami", "completed");
        await clearThread(database.prisma, thread);
        await nothingCameBack();
      });

      it("gets no line back after a rewind to the message that started the run", async () => {
        const { thread, ask, nothingCameBack } = await emptied("Tom", "completed", {
          replies: false,
        });
        await rewindThread(database.prisma, { ...thread, messageId: ask.messageId });
        await nothingCameBack();
      });

      it("gets no line back after a rewind to a message sent while the run was going, once its reply is gone", async () => {
        const { thread, ask, nothingCameBack } = await emptied("Uma", "completed", {
          startedFirst: true,
        });
        await rewindThread(database.prisma, { ...thread, messageId: ask.messageId });
        await nothingCameBack();
      });

      it("gets no line for a run the clear stopped before it ended", async () => {
        const { run, thread, nothingCameBack } = await emptied("Vic", "running");
        await clearThread(database.prisma, thread);
        expect(
          (await database.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status,
        ).toBe("cancelled");
        await nothingCameBack();
      });
    });
  });
  describe("a card's later state", () => {
    let fence = 0;

    async function paused(
      owner: Awaited<ReturnType<typeof seedBot>>,
      blocks: MessageBlock[],
      effect?: { id: string; kind: string; request: Record<string, unknown> },
    ) {
      const { prisma } = database;
      fence += 1;
      const run = await seedRun(prisma, owner.bot.id, owner.threadId, {
        leaseOwner: "worker",
        leaseFence: fence,
      });
      const attempt = await prisma.attempt.create({
        data: { runId: run.id, fence, status: "running" },
      });
      if (effect) {
        await prisma.externalEffect.create({
          data: {
            id: effect.id,
            spaceId: SPACE,
            runId: run.id,
            kind: effect.kind,
            idempotencyKey: `${run.id}:${effect.kind}`,
            status: "intended",
            request: effect.request as never,
          },
        });
      }
      await pauseRunForInput(prisma, {
        spaceId: SPACE,
        threadId: owner.threadId,
        botId: owner.bot.id,
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: fence,
        blocks,
        ...(effect
          ? { effect: { id: effect.id, kind: effect.kind, proposal: effect.request } }
          : {}),
      });
      const written = await log.readRun(run.id);
      // The card's message is the first entry its blocks wrote.
      const message = written.find((entry) =>
        ["assistant.text", "assistant.ask", "effect.requested"].includes(entry.type),
      );
      const ask = written.find((entry) => entry.type === "assistant.ask");
      return { run, messageId: message!.id, askId: ask?.id };
    }

    const newest = async (sessionId: SessionId) => {
      const entry = (await log.readTail(sessionId)).at(-1)!;
      return { type: entry.type, sessionId: entry.sessionId, payload: entry.payload };
    };

    it("keeps an approval card on its request, the edited card on the edit, and the tapped answer", async () => {
      const owner = await seedBot(database.prisma, "Lovelace");
      const request = { name: "Scout", instructions: "Watch the market." };
      const effectId = `effect_${randomUUID()}`;
      const card = spawnBotApprovalBlock(effectId, request, USER);
      const { run, messageId } = await paused(owner, [card], {
        id: effectId,
        kind: "spawn_bot",
        request,
      });

      await database.prisma.$transaction((tx) =>
        answerRunInputInTransaction(tx, {
          spaceId: SPACE,
          threadId: owner.threadId,
          runId: run.id,
          messageId,
          answeredByUserId: USER,
          answer: "allow",
          edits: { name: "Ranger" },
        }),
      );

      const effects = (await log.readTail(owner.sessionId)).filter((entry) =>
        entry.type.startsWith("effect."),
      );
      expect(
        effects.map(({ type, sessionId, payload }) => {
          const { card, answerId } = payload as {
            card?: Extract<MessageBlock, { kind: "ask" }>;
            answerId?: string;
          };
          return {
            type,
            sessionId,
            card: card && { text: card.text, status: card.status, answer: card.answer },
            answerId,
          };
        }),
      ).toEqual([
        {
          type: "effect.requested",
          sessionId: owner.sessionId,
          card: { text: "Create bot “Scout”?", status: "pending", answer: undefined },
          answerId: undefined,
        },
        {
          type: "effect.edited",
          sessionId: owner.sessionId,
          card: { text: "Create bot “Ranger”?", status: "answered", answer: "allow" },
          answerId: undefined,
        },
        {
          type: "effect.resolved",
          sessionId: owner.sessionId,
          card: undefined,
          answerId: "allow",
        },
      ]);
    });

    it("logs a secret answer as answered, without the secret", async () => {
      const owner = await seedBot(database.prisma, "Babbage");
      const { run, messageId } = await paused(owner, [
        { kind: "ask", text: "Your API key?", input: "secret" },
      ]);

      await database.prisma.$transaction((tx) =>
        answerRunInputInTransaction(
          tx,
          {
            spaceId: SPACE,
            threadId: owner.threadId,
            runId: run.id,
            messageId,
            answeredByUserId: USER,
            answer: "placeholder-secret",
          },
          { store: async () => undefined },
        ),
      );

      expect(await newest(owner.sessionId)).toEqual({
        type: "card.answered",
        sessionId: owner.sessionId,
        payload: { target: messageId, answer: "" },
      });
      expect(JSON.stringify(await log.readTail(owner.sessionId))).not.toContain(
        "placeholder-secret",
      );
      expect(
        projectThreadItems(await log.readRun(run.id)).flatMap((item) =>
          item.kind === "message" ? item.blocks : [],
        ),
      ).toEqual([
        { kind: "ask", text: "Your API key?", input: "secret", status: "answered", answer: "" },
      ]);
    });

    describe("an answer given inside the card", () => {
      const answered = async (owner: Awaited<ReturnType<typeof seedBot>>) =>
        (await log.readTail(owner.sessionId))
          .filter((entry) => entry.type === "card.answered" || entry.type === "user.message")
          .map(({ type, payload }) => ({ type, payload }));

      const answerBy = (threadId: string, runId: string, messageId: string, value: string) =>
        database.prisma.$transaction((tx) =>
          answerRunInputInTransaction(tx, {
            spaceId: SPACE,
            threadId,
            runId,
            messageId,
            answeredByUserId: USER,
            answer: value,
          }),
        );

      async function answer(blocks: MessageBlock[], value: string) {
        const owner = await seedBot(database.prisma, `Answerer ${randomUUID()}`);
        const { run, askId } = await paused(owner, blocks);
        await answerBy(owner.threadId, run.id, askId!, value);
        return { entries: await answered(owner), target: askId };
      }

      const city = {
        id: "city",
        question: "Which city should I start with?",
        options: [
          { id: "paris", label: "Paris" },
          { id: "lyon", label: "Lyon" },
        ],
      };
      it.each<[string, MessageBlock, string, Record<string, unknown>, string]>([
        [
          "a typed answer to an ask",
          { kind: "ask", text: "Which city?" },
          "Lyon",
          { answer: "Lyon" },
          "Lyon",
        ],
        [
          "a tapped action of an ask by its id",
          {
            kind: "ask",
            text: "Which city?",
            actions: [
              { id: "paris", label: "Paris" },
              { id: "lyon", label: "Lyon" },
            ],
          },
          "paris",
          { answer: "paris" },
          "Paris",
        ],
        [
          "a multi-question card's structured answers",
          { kind: "ask", text: "A few questions", questions: [city] },
          JSON.stringify({ city: { selected: ["paris"] } }),
          { answers: { city: { selected: ["paris"] } } },
          "1. Which city should I start with? — Paris",
        ],
      ])(
        "logs %s, then the reply that carries it to the bot",
        async (_, block, value, logged, reply) => {
          const { entries, target } = await answer([block], value);
          expect(entries).toEqual([
            { type: "card.answered", payload: { target, ...logged } },
            {
              type: "user.message",
              payload: {
                blocks: [{ kind: "text", text: reply }],
                replyTo: { entryId: target },
                source: "card",
              },
            },
          ]);
        },
      );

      it("answers a question asked after the message's text by the question's entry", async () => {
        const owner = await seedBot(database.prisma, `Answerer ${randomUUID()}`);
        const { run, messageId, askId } = await paused(owner, [
          { kind: "text", text: "Both cities have a free week." },
          { kind: "ask", text: "Which city?" },
        ]);

        const byMessage = await answerBy(owner.threadId, run.id, messageId, "Lyon");
        await answerBy(owner.threadId, run.id, askId!, "Lyon");

        expect(byMessage).toBeNull();
        expect(await answered(owner)).toEqual([
          { type: "card.answered", payload: { target: askId, answer: "Lyon" } },
          {
            type: "user.message",
            payload: {
              blocks: [{ kind: "text", text: "Lyon" }],
              replyTo: { entryId: askId },
              source: "card",
            },
          },
        ]);
      });
    });

    it("logs an ask the composer answered as answered, on the question's entry", async () => {
      const owner = await seedBot(database.prisma, "Hamilton");
      const { run, askId } = await paused(owner, [
        { kind: "text", text: "Both cities have a free week." },
        { kind: "ask", text: "Which city?" },
      ]);

      const reply = await database.prisma.$transaction(async (tx) => {
        const said = await createThreadMessageInTransaction(tx, {
          threadId: owner.threadId,
          role: "user",
          blocks: [{ kind: "text", text: "Lyon" }],
          clientNonce: "composer-lyon",
        });
        await resumeAskWithComposerTextInTransaction(tx, {
          spaceId: SPACE,
          threadId: owner.threadId,
          runId: run.id,
          text: "Lyon",
        });
        return said;
      });

      expect(await newest(owner.sessionId)).toEqual({
        type: "card.answered",
        sessionId: owner.sessionId,
        payload: { target: askId },
      });
      // A resent message finds the run its answer resumed.
      expect(
        (await runsOfMessage(database.prisma, reply)).answered.map((answered) => answered.id),
      ).toEqual([run.id]);
    });

    it("logs a proposal put away by a typed reply as denied and dismissed", async () => {
      const owner = await seedBot(database.prisma, "Noether");
      const effectId = `effect_${randomUUID()}`;
      const { run } = await paused(
        owner,
        [
          {
            kind: "ask",
            text: "Every Monday at 9",
            approvalEffectId: effectId,
            actions: [
              { id: "allow", label: "Create routine" },
              { id: "deny", label: "Not now" },
            ],
          },
        ],
        { id: effectId, kind: "routine_proposal", request: { name: "Digest" } },
      );

      await database.prisma.$transaction((tx) =>
        dismissProposalWithTextInTransaction(tx, {
          spaceId: SPACE,
          threadId: owner.threadId,
          runId: run.id,
          userId: USER,
        }),
      );

      expect(await newest(owner.sessionId)).toEqual({
        type: "effect.resolved",
        sessionId: owner.sessionId,
        payload: { effectId, decision: "denied", dismissed: true },
      });
    });

    it("logs a preview added to a message and its removal, and nothing for a message the thread does not hold", async () => {
      const { prisma } = database;
      const owner = await seedBot(prisma, "Turing");
      const run = await seedRun(prisma, owner.bot.id, owner.threadId);
      const text: MessageBlock = { kind: "text", text: "See https://example.com" };
      const message = { id: randomUUID() };
      await prisma.$transaction((tx) =>
        appendRunBlocksInTransaction(tx, { id: message.id, runId: run.id, botId: owner.bot.id }, [
          text,
        ]),
      );
      const older = { id: randomUUID() };
      const block = {
        kind: "link_preview",
        url: "https://example.com/",
        format: "compact",
        title: "Example",
      } as const;
      const where = { spaceId: SPACE, threadId: owner.threadId };

      await appendLinkBlocks(prisma, { ...where, messageId: message.id, blocks: [block] });
      const preview = (await log.readTail(owner.sessionId)).at(-1)!;
      await removeLinkPreviewBlock(prisma, { ...where, messageId: message.id });
      const removed = await newest(owner.sessionId);
      await appendLinkBlocks(prisma, { ...where, messageId: older.id, blocks: [block] });
      await removeLinkPreviewBlock(prisma, { ...where, messageId: older.id });

      expect([
        { type: preview.type, sessionId: preview.sessionId, payload: preview.payload },
        removed,
      ]).toEqual([
        {
          type: "link.preview",
          sessionId: owner.sessionId,
          payload: { target: message.id, block },
        },
        {
          type: "link.preview.removed",
          sessionId: owner.sessionId,
          payload: { target: preview.id },
        },
      ]);
      expect(await newest(owner.sessionId)).toEqual(removed);
    });

    it("marks the text of a message the bot sent the person mid-run, and no other", async () => {
      const { prisma } = database;
      const owner = await seedBot(prisma, "Hypatia");
      const run = await seedRun(prisma, owner.bot.id, owner.threadId);
      const said = (text: string, toPerson?: true) =>
        prisma.$transaction((tx) =>
          appendRunBlocksInTransaction(
            tx,
            { id: randomUUID(), runId: run.id, botId: owner.bot.id, toPerson },
            [{ kind: "text", text }],
          ),
        );

      await said("Halfway there.", true);
      await said("Done.");

      expect(
        (await log.readTail(owner.sessionId)).map(({ type, payload }) => ({ type, payload })),
      ).toEqual([
        {
          type: "assistant.text",
          payload: { blocks: [{ kind: "text", text: "Halfway there." }], toPerson: true },
        },
        { type: "assistant.text", payload: { blocks: [{ kind: "text", text: "Done." }] } },
      ]);
    });
  });
  describe("what a thread serves from the log", () => {
    it("replays an open run's progress since the newest append that carried one of its entries", async () => {
      const { prisma } = database;
      const owner = await seedBot(prisma, "Lamarr");
      const run = await seedRun(prisma, owner.bot.id, owner.threadId);
      const other = await seedRun(prisma, owner.bot.id, owner.threadId);
      const progress = (runId: string, text: string) =>
        prisma.$transaction((tx) =>
          appendEventInTransaction(tx, {
            spaceId: SPACE,
            threadId: owner.threadId,
            botId: owner.bot.id,
            type: "thread.progress",
            runId,
            payload: { text },
          }),
        );

      await progress(run.id, "before its entry");
      await writerOf(
        prisma,
        run,
      )({
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "First part." }] },
      });
      await progress(run.id, "after its entry");
      await writerOf(
        prisma,
        other,
      )({
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "Someone else." }] },
      });
      await progress(other.id, "the other run");
      await progress(run.id, "still going");

      const replayed = await progressSinceLastEntry(prisma, owner.threadId, [run.id, other.id]);

      expect(replayed.map(({ type, runId, payload }) => ({ type, runId, payload }))).toEqual([
        { type: "thread.progress", runId: run.id, payload: { text: "after its entry" } },
        { type: "thread.progress", runId: other.id, payload: { text: "the other run" } },
        { type: "thread.progress", runId: run.id, payload: { text: "still going" } },
      ]);
    });

    it("replays a run's progress since its entry rode in a feed event another run's entry led", async () => {
      const { prisma } = database;
      const owner = await seedBot(prisma, "Noether");
      const lead = await seedRun(prisma, owner.bot.id, owner.threadId);
      const run = await seedRun(prisma, owner.bot.id, owner.threadId);
      const progress = (text: string) =>
        prisma.$transaction((tx) =>
          appendEventInTransaction(tx, {
            spaceId: SPACE,
            threadId: owner.threadId,
            botId: owner.bot.id,
            type: "thread.progress",
            runId: run.id,
            payload: { text },
          }),
        );
      const said = (by: { id: string }, text: string) =>
        ({
          type: "assistant.text",
          payload: { blocks: [{ kind: "text", text }] },
          sessionId: owner.sessionId,
          botId: owner.bot.id,
          runId: by.id,
        }) as SessionEntryDraft;

      await progress("before its entry");
      await prisma.$transaction(async (tx) => {
        await appendSessionEntryInTransaction(tx, said(lead, "Leading."));
        await appendSessionEntryInTransaction(tx, said(run, "Following."));
      });
      await progress("after its entry");

      const replayed = await progressSinceLastEntry(prisma, owner.threadId, [run.id, run.id]);

      expect(replayed.map(({ runId, payload }) => ({ runId, payload }))).toEqual([
        { runId: run.id, payload: { text: "after its entry" } },
      ]);
    });

    it("finds the thread of a session through its top-most ancestor, only within its space", async () => {
      const { prisma } = database;
      const owner = await seedBot(prisma, "Meitner");
      const digest = await routineRun(prisma, owner, "Digest");
      const helper = await subagentRun(prisma, { ...digest.run, threadId: owner.threadId });

      expect(
        await Promise.all([
          threadOfSession(prisma, owner.sessionId, SPACE),
          threadOfSession(prisma, digest.routineSessionId, SPACE),
          threadOfSession(prisma, helper.sessionId, SPACE),
          threadOfSession(prisma, helper.sessionId, "space_elsewhere"),
          threadOfSession(prisma, "session_unknown", SPACE),
        ]),
      ).toEqual([owner.threadId, owner.threadId, owner.threadId, null, null]);
    });
  });
});
