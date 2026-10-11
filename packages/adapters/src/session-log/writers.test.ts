import { randomUUID } from "node:crypto";
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import type { MessageBlock, SessionEntry } from "@rakazo/contracts";
import { EntryId, EntrySeq, SessionId } from "@rakazo/contracts";
import { spawnBotApprovalBlock } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  answerRunInputInTransaction,
  appendEventInTransaction,
  appendLinkPreviewBlock,
  appendRunBlocksInTransaction,
  appendRunFinishedInTransaction,
  appendSessionEntryInTransaction,
  cancelRunsInTransaction,
  clearThread,
  createSessionInTransaction,
  createThreadEvents,
  createThreadMessage,
  dismissProposalWithTextInTransaction,
  finalizeRun,
  openRoutineSessionInTransaction,
  pauseRunForInput,
  progressSinceLastEntry,
  removeLinkPreviewBlock,
  resumeAskWithComposerTextInTransaction,
  rewindThread,
  threadOfSession,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageConnectedAgent } from "../agent-connections.js";
import { messageBot, returnBotMessageOutcome } from "../bot-messages.js";
import { openRunLog } from "../executor.js";
import { createSkillLineSweep, writeSkillLines } from "../skill-lines.js";
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
      createThreadMessage(database.prisma, {
        threadId: run.threadId,
        role: "bot",
        botId: run.botId,
        runId: run.id,
        blocks: text(value),
      });
    const ended = (runId: string, status = "completed") =>
      database.prisma.run.update({ where: { id: runId }, data: { status } });

    it("logs each skill once, with its line under the reply, however often the lines are written", async () => {
      const { prisma } = database;
      const { bot, threadId, sessionId } = await seedBot(prisma, "Ines");
      const run = await seedRun(prisma, bot.id, threadId);
      const reply = await replied(run, "Done.");
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
      expect((await prisma.message.findUniqueOrThrow({ where: { id: reply.id } })).blocks).toEqual([
        ...text("Done."),
        { kind: "skill_source", skillId: "user:coffee", name: "Coffee", change: "learned" },
        { kind: "skill_source", skillId: "user:tea", name: "Tea", change: "learned" },
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
          const blocks = (
            await prisma.message.findMany({ where: { threadId: seeded.threadId } })
          ).flatMap((message) => message.blocks as Array<{ kind: string }>);
          expect(blocks.filter((block) => block.kind === "skill_source")).toEqual([]);
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
      const message = await prisma.message.findFirstOrThrow({ where: { runId: run.id } });
      const ask = (await log.readRun(run.id)).find((entry) => entry.type === "assistant.ask");
      return { run, messageId: message.id, askId: ask?.id };
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
    });

    describe("an answer given inside the card", () => {
      const answered = async (owner: Awaited<ReturnType<typeof seedBot>>) =>
        (await log.readTail(owner.sessionId))
          .filter((entry) => entry.type === "card.answered" || entry.type === "user.message")
          .map(({ type, payload }) => ({ type, payload }));

      async function answer(blocks: MessageBlock[], value: string) {
        const owner = await seedBot(database.prisma, `Answerer ${randomUUID()}`);
        const { run, messageId, askId } = await paused(owner, blocks);
        const answerBy = (id: string) =>
          database.prisma.$transaction((tx) =>
            answerRunInputInTransaction(tx, {
              spaceId: SPACE,
              threadId: owner.threadId,
              runId: run.id,
              messageId: id,
              answeredByUserId: USER,
              answer: value,
            }),
          );
        const byMessage = askId === messageId ? null : await answerBy(messageId);
        await answerBy(askId!);
        return { entries: await answered(owner), target: askId, byMessage };
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
        const { entries, target, byMessage } = await answer(
          [
            { kind: "text", text: "Both cities have a free week." },
            { kind: "ask", text: "Which city?" },
          ],
          "Lyon",
        );

        expect(byMessage).toBeNull();
        expect(entries).toEqual([
          { type: "card.answered", payload: { target, answer: "Lyon" } },
          {
            type: "user.message",
            payload: {
              blocks: [{ kind: "text", text: "Lyon" }],
              replyTo: { entryId: target },
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

      await database.prisma.$transaction((tx) =>
        resumeAskWithComposerTextInTransaction(tx, {
          spaceId: SPACE,
          threadId: owner.threadId,
          runId: run.id,
          text: "Lyon",
        }),
      );

      expect(await newest(owner.sessionId)).toEqual({
        type: "card.answered",
        sessionId: owner.sessionId,
        payload: { target: askId },
      });
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

    it("logs a preview added to a message and its removal, and nothing for a message older than the log", async () => {
      const { prisma } = database;
      const owner = await seedBot(prisma, "Turing");
      const run = await seedRun(prisma, owner.bot.id, owner.threadId);
      const text: MessageBlock = { kind: "text", text: "See https://example.com" };
      const message = await createThreadMessage(prisma, {
        threadId: owner.threadId,
        role: "bot",
        blocks: [text],
        botId: owner.bot.id,
        runId: run.id,
      });
      await prisma.$transaction((tx) =>
        appendRunBlocksInTransaction(tx, { id: message.id, runId: run.id, botId: owner.bot.id }, [
          text,
        ]),
      );
      const older = await createThreadMessage(prisma, {
        threadId: owner.threadId,
        role: "bot",
        blocks: [{ kind: "text", text: "Before the log" }],
        botId: owner.bot.id,
      });
      const block = {
        kind: "link_preview",
        url: "https://example.com/",
        format: "compact",
        title: "Example",
      } as const;
      const where = { spaceId: SPACE, threadId: owner.threadId };

      await appendLinkPreviewBlock(prisma, { ...where, messageId: message.id, block });
      const preview = (await log.readTail(owner.sessionId)).at(-1)!;
      await removeLinkPreviewBlock(prisma, { ...where, messageId: message.id });
      const removed = await newest(owner.sessionId);
      await appendLinkPreviewBlock(prisma, { ...where, messageId: older.id, block });
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
