import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { projectThreadItems } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackfillRefused, backfillThread } from "./backfill-session-log.js";
import type { PrismaClient } from "./client.js";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.test-support.js";
import { sessionEntryFromRow } from "./sessions.js";

const DROP = "20261012000000_drop_messages";
const SPACE = "space_backfill";
const USER = "user_backfill";
const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, second));

let database: PgliteDatabase;
let pglite: PGlite;

beforeAll(async () => {
  const names = await migrationNames();
  database = await openPgliteDatabase(async (instance) => {
    pglite = instance;
    for (const name of names.filter((name) => name !== DROP)) await applyMigration(instance, name);
  });
  const { prisma } = database;
  await prisma.user.create({ data: { id: USER, name: "U", email: "u@rakazo.test" } });
  await prisma.organization.create({
    data: { id: "org_backfill", name: "O", slug: "org-backfill", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org_backfill", name: "S" } });
});
afterAll(() => database.close());

async function seedThread(prisma: PrismaClient, name: string) {
  const bot = await prisma.bot.create({
    data: { spaceId: SPACE, userId: USER, name, color: "#00C46A" },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  return { botId: bot.id, threadId: thread.id, sessionId: thread.sessionId };
}

async function seedRun(
  prisma: PrismaClient,
  thread: { botId: string; threadId: string },
  id: string,
  fields: {
    sourceMessageId?: string;
    routineId?: string;
    trigger?: string;
    startedAt?: Date;
    completedAt?: Date;
  } = {},
) {
  const task = await prisma.task.create({
    data: {
      spaceId: SPACE,
      botId: thread.botId,
      threadId: thread.threadId,
      userId: USER,
      prompt: "",
      status: "completed",
    },
  });
  return prisma.run.create({
    data: {
      id,
      spaceId: SPACE,
      botId: thread.botId,
      threadId: thread.threadId,
      taskId: task.id,
      userId: USER,
      status: "completed",
      trigger: fields.trigger ?? "user",
      modelProvider: "anthropic",
      modelId: "claude",
      startedAt: at(1),
      completedAt: at(9),
      ...fields,
    },
  });
}

type Legacy = {
  id: string;
  seq: number;
  role: "user" | "bot" | "system";
  blocks: unknown[];
  runId?: string;
  botId?: string;
  replyToMessageId?: string;
  clientNonce?: string;
  at?: Date;
};

async function seedMessages(prisma: PrismaClient, threadId: string, messages: Legacy[]) {
  for (const message of messages) {
    await prisma.$executeRaw`
      INSERT INTO messages (id, "threadId", seq, role, blocks, "botId", "runId", "replyToMessageId",
        "clientNonce", "createdAt")
      VALUES (${message.id}, ${threadId}, ${message.seq}, ${message.role},
        ${JSON.stringify(message.blocks)}::jsonb, ${message.botId ?? null}, ${message.runId ?? null},
        ${message.replyToMessageId ?? null}, ${message.clientNonce ?? null},
        ${message.at ?? at(message.seq)})`;
  }
}

async function entriesOf(prisma: PrismaClient, sessionId: string) {
  const rows = await prisma.sessionEntry.findMany({
    where: { sessionId },
    orderBy: { seq: "asc" },
  });
  return rows.map(sessionEntryFromRow);
}

async function readMigration() {
  return readFile(new URL(`../prisma/migrations/${DROP}/migration.sql`, import.meta.url), "utf8");
}

/** Whether the drop migration would apply now, rolled back either way. */
async function dropApplies(): Promise<boolean> {
  const sql = await readMigration();
  await pglite.exec("BEGIN");
  try {
    await pglite.exec(sql);
    return true;
  } catch (error) {
    expect(String(error)).toMatch(/run scripts\/backfill-session-log\.ts/);
    return false;
  } finally {
    await pglite.exec("ROLLBACK");
  }
}

async function messagesWithoutEntries(prisma: PrismaClient, threadId: string) {
  return prisma.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM messages m
    WHERE m."threadId" = ${threadId}
      AND NOT EXISTS (SELECT 1 FROM session_entries e WHERE e.id = m.id)`;
}

describe("backfillThread", () => {
  it("writes a thread's messages as its main session's chain, the summary last", async () => {
    const { prisma } = database;
    const thread = await seedThread(prisma, "Ada");
    await seedMessages(prisma, thread.threadId, [
      { id: "m1", seq: 0, role: "user", blocks: [{ kind: "text", text: "Find competitors." }] },
    ]);
    await seedRun(prisma, thread, "r1", { sourceMessageId: "m1" });
    await prisma.usageRecord.create({
      data: {
        spaceId: SPACE,
        userId: USER,
        runId: "r1",
        provider: "anthropic",
        model: "claude",
        inputTokens: 100,
        outputTokens: 20,
      },
    });
    await seedMessages(prisma, thread.threadId, [
      {
        id: "m2",
        seq: 1,
        role: "bot",
        runId: "r1",
        botId: thread.botId,
        blocks: [
          {
            kind: "steps",
            steps: [
              {
                label: "Web search",
                count: 1,
                calls: [{ name: "web_search", input: '{"q":"rivals"}', output: "Acme", id: "c1" }],
              },
              { label: "Read page", count: 1 },
            ],
          },
          {
            kind: "subagent",
            agentId: "agent_1",
            name: "scout",
            task: "List rivals",
            status: "completed",
            result: "Acme",
          },
          { kind: "text", text: "Acme is your rival." },
        ],
      },
    ]);
    await prisma.$executeRaw`
      UPDATE threads SET "historyCompactedUpToSeq" = 0,
        "historyCompactionSummary" = 'Asked about competitors.'
      WHERE id = ${thread.threadId}`;

    await expect(backfillThread(prisma, thread.threadId)).resolves.toMatchObject({
      outcome: "backfilled",
      messages: 2,
      entries: 10,
    });

    const run = { botId: thread.botId, runId: "r1" };
    const model = { provider: "anthropic", id: "claude" };
    expect(
      (await entriesOf(prisma, thread.sessionId)).map(({ id, seq, type, payload, ...rest }) => ({
        id,
        seq,
        type,
        payload,
        ...("runId" in rest ? { runId: rest.runId, botId: rest.botId } : {}),
      })),
    ).toEqual([
      {
        id: "m1",
        seq: 0,
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: "Find competitors." }], source: "app" },
      },
      {
        id: expect.any(String),
        seq: 1,
        type: "run.started",
        payload: { trigger: { kind: "message", entryId: "m1" }, model, effort: null },
        ...run,
      },
      {
        id: "m2",
        seq: 2,
        type: "tool.call",
        payload: { callId: "c1", name: "web_search", input: '{"q":"rivals"}' },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 3,
        type: "tool.result",
        payload: { callId: "c1", output: "Acme", isError: false, artifactIds: [] },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 4,
        type: "tool.call",
        payload: { callId: "legacy_m2_1", name: "read_page", input: "{}" },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 5,
        type: "tool.result",
        payload: { callId: "legacy_m2_1", output: "", isError: false, artifactIds: [] },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 6,
        type: "subagent",
        payload: {
          callId: "agent_1",
          name: "scout",
          model,
          task: "List rivals",
          status: "completed",
          result: "Acme",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 7,
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "Acme is your rival." }] },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 8,
        type: "run.finished",
        payload: { status: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
        ...run,
      },
      {
        id: expect.any(String),
        seq: 9,
        type: "compaction",
        payload: { summary: "Asked about competitors.", coveredUpToSeq: 0 },
      },
    ]);
    expect(
      await prisma.conversationSession.findUniqueOrThrow({ where: { id: thread.sessionId } }),
    ).toMatchObject({ nextEntrySeq: 10 });

    await expect(backfillThread(prisma, thread.threadId)).resolves.toEqual({
      threadId: thread.threadId,
      outcome: "skipped",
    });
    expect(await prisma.sessionEntry.count({ where: { sessionId: thread.sessionId } })).toBe(10);
  });

  it("keeps cards, previews, skills, peer messages and a routine's card as the thread showed them", async () => {
    const { prisma } = database;
    const sender = await seedThread(prisma, "Grace");
    const receiver = await seedThread(prisma, "Linus");
    await seedRun(prisma, sender, "r_send");
    const routine = await prisma.routine.create({
      data: {
        spaceId: SPACE,
        botId: sender.botId,
        threadId: sender.threadId,
        userId: USER,
        name: "Digest",
        prompt: "Summarize",
        crons: [],
        timezone: "UTC",
      },
    });
    await seedRun(prisma, sender, "r_routine", { trigger: "routine", routineId: routine.id });
    const card = {
      kind: "link_preview",
      url: "https://example.com/",
      format: "compact",
      title: "Example",
    };
    const ask = { kind: "ask", text: "Which city?", status: "answered", answer: "Lyon" };
    const routineAsk = { kind: "ask", text: "Email them?", status: "pending" };
    const playbook = {
      whenToUse: "Coffee runs",
      inputs: [],
      steps: ["Open the app"],
      howToCheck: "",
      whatToReturn: "",
      approvalBoundaries: "",
      failureHandling: "",
    };
    const draft = {
      kind: "skill_draft",
      skillId: "skill_1",
      name: "Order",
      goal: "Order coffee",
      playbook,
      status: "draft",
    };
    await seedMessages(prisma, sender.threadId, [
      {
        id: "s1",
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "See https://example.com" }, card],
      },
      { id: "s2", seq: 1, role: "bot", runId: "r_send", botId: sender.botId, blocks: [ask] },
      {
        id: "s3",
        seq: 2,
        role: "bot",
        runId: "r_send",
        botId: sender.botId,
        blocks: [
          { kind: "text", text: "Asking Linus." },
          { kind: "bot_message_sent", toBotId: receiver.botId, toBotName: "Linus", text: "Hi" },
          { kind: "skill_source", skillId: "user:coffee", name: "Coffee", change: "learned" },
        ],
      },
      { id: "s4", seq: 3, role: "bot", botId: sender.botId, blocks: [draft] },
      {
        id: "s5",
        seq: 4,
        role: "bot",
        runId: "r_routine",
        botId: sender.botId,
        blocks: [
          {
            kind: "routine_run",
            routineId: routine.id,
            routineName: "Digest",
            state: "completed",
            digest: "All quiet.",
            startedAt: at(4).toISOString(),
          },
        ],
      },
      {
        id: "s6",
        seq: 5,
        role: "bot",
        runId: "r_routine",
        botId: sender.botId,
        blocks: [{ kind: "text", text: "Two leads." }, routineAsk],
      },
    ]);
    const later = await seedThread(prisma, "Ken");
    await seedRun(prisma, later, "r_later");
    await seedMessages(prisma, later.threadId, [
      {
        id: "k1",
        seq: 0,
        role: "bot",
        runId: "r_later",
        botId: later.botId,
        blocks: [
          { kind: "bot_message_sent", toBotId: receiver.botId, toBotName: "Linus", text: "Yo" },
        ],
      },
    ]);
    await seedMessages(prisma, receiver.threadId, [
      {
        id: "q1",
        seq: 0,
        role: "user",
        clientNonce: "bot-message:call-1",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: sender.botId,
            fromBotName: "Grace",
            text: "Hi",
            hop: 1,
            returnToMessageId: "s3",
          },
        ],
      },
      {
        id: "q2",
        seq: 1,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: later.botId,
            fromBotName: "Ken",
            text: "Yo",
            returnToMessageId: "k1",
          },
        ],
      },
    ]);

    await backfillThread(prisma, sender.threadId);
    await backfillThread(prisma, receiver.threadId);
    await backfillThread(prisma, later.threadId);

    const entries = await entriesOf(prisma, sender.sessionId);
    const routineStarted = entries.find((entry) => entry.type === "routine.started");
    const sent = entries.find((entry) => entry.type === "bot.message.sent");
    expect(sent?.id).not.toBe("s3");
    expect(
      entries
        .map(({ id, type, payload }) => ({ id, type, payload }))
        .filter(({ type }) =>
          [
            "link.preview",
            "card.answered",
            "bot.message.sent",
            "skill.learnt",
            "bot.text",
            "skill.draft",
            "routine.finished",
          ].includes(type),
        ),
    ).toEqual([
      { id: expect.any(String), type: "link.preview", payload: { target: "s1", block: card } },
      { id: expect.any(String), type: "card.answered", payload: { target: "s2", answer: "Lyon" } },
      {
        id: sent!.id,
        type: "bot.message.sent",
        payload: {
          to: { kind: "bot", botId: receiver.botId, name: "Linus" },
          text: "Hi",
          intent: "request",
          hop: 1,
          exchangeId: sent!.id,
        },
      },
      {
        id: expect.any(String),
        type: "skill.learnt",
        payload: { skillId: "user:coffee", name: "Coffee", change: "learned" },
      },
      { id: "s4", type: "bot.text", payload: { blocks: [draft] } },
      {
        id: expect.any(String),
        type: "skill.draft",
        payload: {
          target: "s4",
          skillId: "skill_1",
          name: "Order",
          goal: "Order coffee",
          playbook,
          status: "draft",
        },
      },
      {
        id: expect.any(String),
        type: "routine.finished",
        payload: {
          status: "completed",
          usage: { inputTokens: 0, outputTokens: 0 },
          result: "All quiet.",
        },
      },
    ]);
    expect(routineStarted).toMatchObject({
      id: "s5",
      payload: { routineId: routine.id, name: "Digest", trigger: "routine" },
    });
    const routineSession = (routineStarted!.payload as { sessionId: string }).sessionId;
    expect(
      await prisma.conversationSession.findUniqueOrThrow({ where: { id: routineSession } }),
    ).toMatchObject({ kind: "routine", parentSessionId: sender.sessionId });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: "r_routine" } })).toMatchObject({
      sessionId: routineSession,
    });
    expect(
      entries.filter((entry) => entry.type === "assistant.ask" && entry.runId === "r_routine"),
    ).toMatchObject([{ payload: { block: routineAsk, originSessionId: routineSession } }]);
    expect((await entriesOf(prisma, routineSession)).map((entry) => entry.type)).toEqual([
      "run.started",
      "assistant.text",
      "run.finished",
    ]);

    const items = projectThreadItems(entries.map(({ sessionId: _sessionId, ...entry }) => entry));
    expect(items.flatMap((item) => (item.kind === "message" ? item.blocks : []))).toEqual([
      { kind: "text", text: "See https://example.com" },
      card,
      ask,
      { kind: "text", text: "Asking Linus." },
      draft,
      routineAsk,
    ]);

    expect(
      (await entriesOf(prisma, receiver.sessionId)).map(({ id, type, payload }) => ({
        id,
        type,
        payload,
      })),
    ).toEqual([
      {
        id: "q1",
        type: "bot.message.received",
        payload: {
          from: { kind: "bot", botId: sender.botId, name: "Grace" },
          fromSessionId: sender.sessionId,
          fromEntryId: sent!.id,
          text: "Hi",
          intent: "request",
          hop: 1,
          exchangeId: sent!.id,
          clientNonce: "bot-message:call-1",
        },
      },
      {
        id: "q2",
        type: "bot.message.received",
        payload: {
          from: { kind: "bot", botId: later.botId, name: "Ken" },
          text: "Yo",
          intent: "request",
          hop: 1,
          exchangeId: "q2",
        },
      },
    ]);
  });
});

describe("a message's id", () => {
  it("lands on one entry of the message, and nothing shows for a message that showed nothing", async () => {
    const { prisma } = database;
    const thread = await seedThread(prisma, "Barbara");
    await seedRun(prisma, thread, "r_quiet");
    await seedMessages(prisma, thread.threadId, [
      { id: "b1", seq: 0, role: "user", blocks: [{ kind: "text", text: "Teach me." }] },
      {
        id: "b2",
        seq: 1,
        role: "bot",
        botId: thread.botId,
        blocks: [{ kind: "skill_source", skillId: "user:tea", name: "Tea", change: "learned" }],
      },
      {
        id: "b3",
        seq: 2,
        role: "bot",
        runId: "r_quiet",
        botId: thread.botId,
        blocks: [{ kind: "progress", text: "Working", activity: true }],
      },
      { id: "b4", seq: 3, role: "bot", botId: thread.botId, blocks: [] },
    ]);

    await backfillThread(prisma, thread.threadId);

    const entries = await entriesOf(prisma, thread.sessionId);
    expect(entries.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "b1", type: "user.message" },
      { id: "b2", type: "skill.learnt" },
      { id: expect.any(String), type: "run.started" },
      { id: "b3", type: "run.finished" },
      { id: "b4", type: "bot.text" },
    ]);
    expect(await messagesWithoutEntries(prisma, thread.threadId)).toEqual([]);
    const items = projectThreadItems(entries.map(({ sessionId: _sessionId, ...entry }) => entry));
    expect(items.flatMap((item) => (item.kind === "message" ? item.blocks : []))).toEqual([
      { kind: "text", text: "Teach me." },
    ]);
  });
});

describe("a thread whose log already holds entries", () => {
  it("takes the messages written after its backfill onto the end of its log", async () => {
    const { prisma } = database;
    const thread = await seedThread(prisma, "Dana");
    const text = (value: string) => [{ kind: "text", text: value }];
    await seedMessages(prisma, thread.threadId, [
      { id: "n1", seq: 0, role: "user", blocks: text("Plan a trip.") },
    ]);
    await seedRun(prisma, thread, "r_n1", { sourceMessageId: "n1" });
    await seedMessages(prisma, thread.threadId, [
      { id: "n2", seq: 1, role: "bot", runId: "r_n1", botId: thread.botId, blocks: text("Where?") },
    ]);
    await backfillThread(prisma, thread.threadId);
    expect(await dropApplies()).toBe(true);

    await seedMessages(prisma, thread.threadId, [
      { id: "n3", seq: 2, role: "user", blocks: text("Lisbon."), at: at(40) },
    ]);
    await seedRun(prisma, thread, "r_n2", {
      sourceMessageId: "n3",
      startedAt: at(41),
      completedAt: at(43),
    });
    await seedMessages(prisma, thread.threadId, [
      {
        id: "n4",
        seq: 3,
        role: "bot",
        runId: "r_n2",
        botId: thread.botId,
        blocks: text("Booked."),
        at: at(42),
      },
    ]);
    expect(await dropApplies()).toBe(false);

    await expect(backfillThread(prisma, thread.threadId)).resolves.toMatchObject({
      outcome: "appended",
      messages: 2,
      entries: 4,
    });

    const entries = await entriesOf(prisma, thread.sessionId);
    expect(entries.map(({ id, seq, type }) => ({ id, seq, type }))).toEqual([
      { id: "n1", seq: 0, type: "user.message" },
      { id: expect.any(String), seq: 1, type: "run.started" },
      { id: "n2", seq: 2, type: "assistant.text" },
      { id: expect.any(String), seq: 3, type: "run.finished" },
      { id: "n3", seq: 4, type: "user.message" },
      { id: expect.any(String), seq: 5, type: "run.started" },
      { id: "n4", seq: 6, type: "assistant.text" },
      { id: expect.any(String), seq: 7, type: "run.finished" },
    ]);
    expect(entries.map((entry) => entry.parentId)).toEqual([
      null,
      ...entries.slice(0, -1).map((entry) => entry.id),
    ]);
    expect(entries[5]).toMatchObject({ payload: { trigger: { kind: "message", entryId: "n3" } } });
    expect(
      await prisma.conversationSession.findUniqueOrThrow({ where: { id: thread.sessionId } }),
    ).toMatchObject({ nextEntrySeq: 8, headEntryId: entries[7]!.id });
    expect(await dropApplies()).toBe(true);
  });

  it("refuses messages older than its log, until the thread is rebuilt from them", async () => {
    const { prisma } = database;
    const thread = await seedThread(prisma, "Erin");
    await seedMessages(prisma, thread.threadId, [
      { id: "o1", seq: 0, role: "user", blocks: [{ kind: "text", text: "Hello" }] },
    ]);
    await seedRun(prisma, thread, "r_o1", { sourceMessageId: "o1" });
    await seedMessages(prisma, thread.threadId, [
      {
        id: "o2",
        seq: 1,
        role: "bot",
        runId: "r_o1",
        botId: thread.botId,
        blocks: [{ kind: "text", text: "Hi there." }],
      },
    ]);
    await prisma.sessionEntry.create({
      data: {
        id: "o_live",
        sessionId: thread.sessionId,
        seq: 0,
        parentId: null,
        type: "system.note",
        payload: { text: "Joined." },
        createdAt: at(50),
      },
    });
    await prisma.conversationSession.update({
      where: { id: thread.sessionId },
      data: { nextEntrySeq: 1, headEntryId: "o_live" },
    });
    const helper = await prisma.conversationSession.create({
      data: {
        id: "ses_helper_o",
        spaceId: SPACE,
        kind: "subagent",
        parentSessionId: thread.sessionId,
        parentEntryId: "o_live",
      },
    });

    await expect(backfillThread(prisma, thread.threadId)).rejects.toThrow(BackfillRefused);
    await expect(backfillThread(prisma, thread.threadId)).rejects.toThrow(
      `--rebuild-from-messages ${thread.threadId}`,
    );
    expect(await dropApplies()).toBe(false);

    await expect(backfillThread(prisma, thread.threadId, { rebuild: true })).resolves.toMatchObject(
      { outcome: "rebuilt", messages: 2, entries: 4 },
    );

    const { sessionId } = await prisma.thread.findUniqueOrThrow({ where: { id: thread.threadId } });
    expect(sessionId).not.toBe(thread.sessionId);
    expect(
      await prisma.conversationSession.findMany({
        where: { id: { in: [thread.sessionId, helper.id] } },
      }),
    ).toEqual([]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: "r_o1" } })).toMatchObject({
      sessionId,
    });
    expect((await entriesOf(prisma, sessionId)).map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "o1", type: "user.message" },
      { id: expect.any(String), type: "run.started" },
      { id: "o2", type: "assistant.text" },
      { id: expect.any(String), type: "run.finished" },
    ]);
    expect(await dropApplies()).toBe(true);
  });
});

describe("the migration that drops the messages", () => {
  it("refuses while a thread's messages are not in the log, then drops them and keeps every link", async () => {
    const { prisma } = database;
    const thread = await seedThread(prisma, "Edsger");
    await seedMessages(prisma, thread.threadId, [
      { id: "d1", seq: 0, role: "user", blocks: [{ kind: "text", text: "Hello" }] },
    ]);
    await seedRun(prisma, thread, "r_drop", { sourceMessageId: "d1" });
    await seedMessages(prisma, thread.threadId, [
      {
        id: "d2",
        seq: 1,
        role: "bot",
        runId: "r_drop",
        botId: thread.botId,
        blocks: [{ kind: "text", text: "See https://example.com" }],
      },
    ]);
    await prisma.steeringMessage.create({
      data: { messageId: "d1", botId: thread.botId, userId: USER, runId: "r_drop" },
    });
    await prisma.externalConversation.create({
      data: {
        id: "xc_drop",
        provider: "slack",
        workspaceId: "T_drop",
        externalKey: "slack:T_drop:C_drop",
        conversationId: "C_drop",
        spaceId: SPACE,
        botId: thread.botId,
        userId: USER,
      },
    });
    await prisma.externalMessage.create({
      data: {
        externalConversationId: "xc_drop",
        providerEventId: "ev_drop",
        senderId: "U_drop",
        senderName: "U",
        content: "Hello",
        threadMessageId: "d1",
      },
    });
    await prisma.artifact.create({
      data: {
        spaceId: SPACE,
        botId: thread.botId,
        userId: USER,
        name: "preview.png",
        mimeType: "image/png",
        size: 1,
        hash: "h_drop",
        storageKey: "k_drop",
        isLinkPreview: true,
        previewMessageId: "d2",
      },
    });
    const migration = async () => pglite.exec(await readMigration());

    await expect(migration()).rejects.toThrow(/run scripts\/backfill-session-log\.ts/);
    expect(await prisma.$queryRaw`SELECT id FROM messages WHERE id = 'd1'`).toEqual([{ id: "d1" }]);

    for (const { id } of await prisma.thread.findMany({ select: { id: true } })) {
      await backfillThread(prisma, id);
    }
    await migration();

    expect(await prisma.$queryRaw`SELECT to_regclass('public.messages')::text AS messages`).toEqual(
      [{ messages: null }],
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: "r_drop" } })).toMatchObject({
      sourceMessageId: "d1",
    });
    expect(
      await prisma.steeringMessage.findMany({
        where: { runId: "r_drop" },
        select: { messageId: true },
      }),
    ).toEqual([{ messageId: "d1" }]);
    expect(
      await prisma.externalMessage.findFirstOrThrow({ where: { providerEventId: "ev_drop" } }),
    ).toMatchObject({ threadMessageId: "d1" });
    expect(
      await prisma.artifact.findFirstOrThrow({ where: { storageKey: "k_drop" } }),
    ).toMatchObject({ previewMessageId: "d2" });
    expect(
      await prisma.$queryRaw`
        SELECT conname, confrelid::regclass::text AS target FROM pg_constraint
        WHERE conname IN ('runs_sourceMessageId_fkey', 'steering_messages_messageId_fkey',
          'external_messages_threadMessageId_fkey', 'artifacts_previewMessageId_fkey')
        ORDER BY conname`,
    ).toEqual([
      { conname: "artifacts_previewMessageId_fkey", target: "session_entries" },
      { conname: "external_messages_threadMessageId_fkey", target: "session_entries" },
      { conname: "runs_sourceMessageId_fkey", target: "session_entries" },
      { conname: "steering_messages_messageId_fkey", target: "session_entries" },
    ]);
  });
});
