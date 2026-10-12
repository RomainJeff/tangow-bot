import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBotMessageContexts } from "./bot-message-context.js";
import type { PrismaClient } from "./client.js";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { openPgliteDatabase } from "./pglite.test-support.js";
import { personAnsweredRun } from "./sessions.js";
import { sessionPreviews } from "./thread-listing.js";

const SPACE = "space_readers";
const USER = "user_readers";
const MODEL = { provider: "anthropic", id: "claude" };

let database: PgliteDatabase;

beforeAll(async () => {
  database = await openPgliteDatabase();
  const { prisma } = database;
  await prisma.user.create({ data: { id: USER, name: "U", email: "readers@rakazo.test" } });
  await prisma.organization.create({
    data: { id: "org_readers", name: "O", slug: "org-readers", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org_readers", name: "S" } });
});
afterAll(() => database.close());

let seeded = 0;

async function seedThread(prisma: PrismaClient) {
  seeded += 1;
  const bot = await prisma.bot.create({
    data: { spaceId: SPACE, userId: USER, name: `Bot ${seeded}`, color: "#00C46A" },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  return { botId: bot.id, threadId: thread.id, sessionId: thread.sessionId };
}

async function seedRun(
  prisma: PrismaClient,
  thread: { botId: string; threadId: string },
  run: { id: string; trigger?: string; sourceMessageId?: string },
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
  await prisma.run.create({
    data: {
      spaceId: SPACE,
      botId: thread.botId,
      threadId: thread.threadId,
      taskId: task.id,
      userId: USER,
      status: "completed",
      trigger: "user",
      ...run,
    },
  });
}

type Row = { id: string; type: string; payload: object; runId?: string; botId?: string };

/** Writes a chain of entries to a session as rows, ids and links given. */
async function write(prisma: PrismaClient, sessionId: string, entries: Row[]) {
  await prisma.sessionEntry.createMany({
    data: entries.map((entry, seq) => ({
      ...entry,
      sessionId,
      seq,
      parentId: seq === 0 ? null : entries[seq - 1]!.id,
      createdAt: new Date(Date.UTC(2026, 9, 1, 9, 0, seq)),
    })),
  });
  await prisma.conversationSession.update({
    where: { id: sessionId },
    data: { nextEntrySeq: entries.length, headEntryId: entries.at(-1)!.id },
  });
}

const said = (id: string, text: string): Row => ({
  id,
  type: "user.message",
  payload: { blocks: [{ kind: "text", text }], source: "app" },
});
const started = (id: string, runId: string, botId: string): Row => ({
  id,
  type: "run.started",
  payload: { trigger: { kind: "direct" }, model: MODEL, effort: null },
  runId,
  botId,
});
const asked = (id: string, runId: string, botId: string, block: object): Row => ({
  id,
  type: "assistant.ask",
  payload: { block: { kind: "ask", text: "Which city?", ...block } },
  runId,
  botId,
});

describe("whether the person answered a run", () => {
  it("counts a question they answered and an approval they decided, never a settled confirmation or a waiting question", async () => {
    const { prisma } = database;
    const thread = await seedThread(prisma);
    const { botId } = thread;
    await write(prisma, thread.sessionId, [
      said("a0", "Plan my week"),
      started("a1", "run_answered", botId),
      asked("a2", "run_answered", botId, {}),
      { id: "a3", type: "card.answered", payload: { target: "a2", answer: "Lyon" } },
      started("a4", "run_confirmed", botId),
      asked("a5", "run_confirmed", botId, { confirms: { routineId: "routine_1" } }),
      { id: "a6", type: "card.answered", payload: { target: "a5" } },
      started("a7", "run_waiting", botId),
      asked("a8", "run_waiting", botId, {}),
      started("a9", "run_approved", botId),
      {
        id: "a10",
        type: "effect.resolved",
        payload: { effectId: "effect_1", decision: "approved" },
        runId: "run_approved",
        botId,
      },
    ]);

    expect(
      await Promise.all(
        ["run_answered", "run_confirmed", "run_waiting", "run_approved"].map((runId) =>
          personAnsweredRun(prisma, runId),
        ),
      ),
    ).toEqual([true, false, false, true]);
  });
});

describe("a peer's message to a bot", () => {
  const sent = (id: string, runId: string, botId: string, to: string, intent: string): Row => ({
    id,
    type: "bot.message.sent",
    payload: {
      to: { kind: "bot", botId: to, name: "Peer" },
      text: "Find the venues.",
      intent,
      hop: 1,
      exchangeId: id,
    },
    runId,
    botId,
  });
  const received = (id: string, from: string, intent: string, exchangeId: string): Row => ({
    id,
    type: "bot.message.received",
    payload: {
      from: { kind: "bot", botId: from, name: "Peer" },
      fromSessionId: "session_peer",
      fromEntryId: `${id}_sent`,
      text: "Here they are.",
      intent,
      hop: 2,
      exchangeId,
    },
  });

  it("replies to the request its bot sent only as a result from the bot asked, never as an FYI or from another bot", async () => {
    const { prisma } = database;
    const asker = await seedThread(prisma);
    const peer = await seedThread(prisma);
    const other = await seedThread(prisma);
    await write(prisma, asker.sessionId, [
      said("b0", "Ask the peer"),
      started("b1", "run_asker", asker.botId),
      sent("b2", "run_asker", asker.botId, peer.botId, "request"),
      received("b3", peer.botId, "result", "b2"),
      received("b4", peer.botId, "fyi", "b2"),
      received("b5", other.botId, "result", "b2"),
    ]);

    const contexts = await loadBotMessageContexts(prisma, ["b3", "b4", "b5"]);

    expect(
      ["b3", "b4", "b5"].map((id) => {
        const context = contexts.get(id);
        return [context?.repliesToRequest, context?.requestRunId];
      }),
    ).toEqual([
      [true, "run_asker"],
      [false, undefined],
      [false, undefined],
    ]);
  });
});

describe("a thread list's preview", () => {
  it("shows the newest words, skipping a hidden peer run's but keeping what it tells the person, and keeps a relay's", async () => {
    const { prisma } = database;
    const relay = await seedThread(prisma);
    const hidden = await seedThread(prisma);
    const told = await seedThread(prisma);
    const peer = "bot_peer";
    const received = (id: string, intent: string): Row => ({
      id,
      type: "bot.message.received",
      payload: {
        from: { kind: "bot", botId: peer, name: "Peer" },
        fromSessionId: "session_peer",
        fromEntryId: `${id}_sent`,
        text: "Over to you.",
        intent,
        hop: 1,
        exchangeId: `${id}_sent`,
      },
    });
    const text = (id: string, runId: string, botId: string, words: string): Row => ({
      id,
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: words }] },
      runId,
      botId,
    });
    await write(prisma, relay.sessionId, [
      received("c0", "result"),
      started("c1", "run_relay", relay.botId),
      text("c2", "run_relay", relay.botId, "The venues are booked."),
      {
        id: "c3",
        type: "tool.call",
        payload: { callId: "x", name: "read", input: "{}" },
        runId: "run_relay",
        botId: relay.botId,
      },
    ]);
    await write(prisma, hidden.sessionId, [
      said("d_person", "Hello"),
      received("d0", "request"),
      started("d1", "run_peer", hidden.botId),
      asked("d2", "run_peer", hidden.botId, {}),
      text("d3", "run_peer", hidden.botId, "Working on the peer's request."),
    ]);
    await write(prisma, told.sessionId, [
      said("t_person", "Hello"),
      received("t0", "request"),
      started("t1", "run_told", told.botId),
      {
        ...text("t2", "run_told", told.botId, "I need your calendar to go on."),
        payload: {
          blocks: [{ kind: "text", text: "I need your calendar to go on." }],
          toPerson: true,
        },
      },
      text("t3", "run_told", told.botId, "Working on the peer's request."),
    ]);
    await seedRun(prisma, told, { id: "run_told", trigger: "bot_message", sourceMessageId: "t0" });
    await seedRun(prisma, relay, {
      id: "run_relay",
      trigger: "bot_message",
      sourceMessageId: "c0",
    });
    await seedRun(prisma, hidden, {
      id: "run_peer",
      trigger: "bot_message",
      sourceMessageId: "d0",
    });

    const previews = await sessionPreviews(prisma, [
      relay.sessionId,
      hidden.sessionId,
      told.sessionId,
    ]);

    expect([
      previews.get(relay.sessionId),
      previews.get(hidden.sessionId),
      previews.get(told.sessionId),
    ]).toEqual(["The venues are booked.", "Which city?", "I need your calendar to go on."]);
  });
});
