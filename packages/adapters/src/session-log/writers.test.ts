import type { SessionEntry, SessionId } from "@rakazo/contracts";
import { EntryId, EntrySeq } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendSessionEntryInTransaction,
  clearThread,
  createThreadEvents,
  rewindThread,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageConnectedAgent } from "../agent-connections.js";
import { messageBot, returnBotMessageOutcome } from "../bot-messages.js";
import type { PgliteDatabase } from "./pglite.js";
import { openPgliteDatabase } from "./pglite.js";
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

async function seedRun(prisma: PrismaClient, botId: string, threadId: string) {
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
    },
  });
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

  it("names the history generation each rewind and clear ends, a compaction on the chain or not", async () => {
    const { prisma } = database;
    const { bot, threadId, sessionId } = await seedBot(prisma, "Ada");
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
    await send("Keep this");
    const cut = await send("Edit this");
    await prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        type: "compaction",
        sessionId,
        parentId: EntryId.parse(cut.messageId),
        feedBotId: bot.id,
        payload: { summary: "Kept and edited.", coveredUpToSeq: EntrySeq.parse(1) },
      }),
    );
    const after = await send("After the summary");
    const target = { spaceId: SPACE, threadId, botId: bot.id };

    const keepsCompaction = await rewindThread(prisma, { ...target, messageId: after.messageId });
    const cutsCompaction = await rewindThread(prisma, { ...target, messageId: cut.messageId });
    const firstClear = await clearThread(prisma, target);
    const secondClear = await clearThread(prisma, target);

    expect([
      keepsCompaction?.historyGeneration,
      cutsCompaction?.historyGeneration,
      firstClear.historyGeneration,
      secondClear.historyGeneration,
    ]).toEqual([0, 4, 5, 6]);
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
});
