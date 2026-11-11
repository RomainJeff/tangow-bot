import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { openPgliteDatabase } from "./pglite.test-support.js";
import { exportThreadSessions, importThreadSessions } from "./session-files.js";
import { sessionEntryFromRow } from "./sessions.js";

const SPACE = "space_files";
const USER = "user_files";
const MODEL = { provider: "anthropic", id: "claude" };

let database: PgliteDatabase;

beforeAll(async () => {
  database = await openPgliteDatabase();
  const { prisma } = database;
  await prisma.user.create({ data: { id: USER, name: "U", email: "files@tangow.test" } });
  await prisma.organization.create({
    data: { id: "org_files", name: "O", slug: "org-files", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org_files", name: "S" } });
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

/** Writes a chain of entries to a session as rows, ids and links given. */
async function write(
  prisma: PrismaClient,
  sessionId: string,
  entries: Array<{ id: string; type: string; payload: object; runId?: string; botId?: string }>,
) {
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

describe("a thread's sessions as JSONL files", () => {
  it("exports a thread with its helper and imports it whole into another thread, runs and all", async () => {
    const { prisma } = database;
    const source = await seedThread(prisma, "Ada");
    const { botId } = source;
    const run = { runId: "run_files", botId };
    const before = { runId: "run_before", botId };
    await write(prisma, source.sessionId, [
      {
        id: "p0",
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: "Search first." }], source: "app" },
      },
      {
        id: "p1",
        type: "run.started",
        payload: { trigger: { kind: "message", entryId: "p0" }, model: MODEL, effort: null },
        ...before,
      },
      {
        id: "p2",
        type: "tool.call",
        payload: { callId: "call_scout", name: "web_search", input: "{}" },
        ...before,
      },
      {
        id: "p3",
        type: "run.finished",
        payload: { status: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
        ...before,
      },
      {
        id: "e0",
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: "Find rivals." }], source: "app" },
      },
      {
        id: "e1",
        type: "run.started",
        payload: { trigger: { kind: "message", entryId: "e0" }, model: MODEL, effort: null },
        ...run,
      },
      {
        id: "e2",
        type: "tool.call",
        payload: { callId: "call_scout", name: "run_subagent", input: '{"name":"scout"}' },
        ...run,
      },
    ]);
    const child = await prisma.conversationSession.create({
      data: {
        id: "session_scout",
        spaceId: SPACE,
        kind: "subagent",
        parentSessionId: source.sessionId,
        parentEntryId: "e2",
      },
    });
    await write(prisma, child.id, [
      {
        id: "c_start",
        type: "run.started",
        payload: { trigger: { kind: "subagent", entryId: "e2" }, model: MODEL, effort: null },
        runId: "run_scout",
        botId,
      },
      {
        id: "c0",
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "Acme." }] },
        runId: "run_scout",
        botId,
      },
    ]);
    const rest = [
      {
        id: "e3",
        type: "subagent",
        payload: {
          callId: "call_scout",
          sessionId: child.id,
          name: "scout",
          model: MODEL,
          task: "List rivals",
          status: "completed",
          result: "Acme.",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        ...run,
      },
      {
        id: "e4",
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: "Acme is the one." }] },
        ...run,
      },
      {
        id: "e5",
        type: "run.finished",
        payload: { status: "completed", usage: { inputTokens: 2, outputTokens: 2 } },
        ...run,
      },
    ];
    const head = await prisma.sessionEntry.findMany({ where: { sessionId: source.sessionId } });
    await prisma.sessionEntry.createMany({
      data: rest.map((entry, index) => ({
        ...entry,
        sessionId: source.sessionId,
        seq: head.length + index,
        parentId: index === 0 ? "e2" : rest[index - 1]!.id,
        createdAt: new Date(Date.UTC(2026, 9, 1, 9, 1, index)),
      })),
    });
    await prisma.conversationSession.update({
      where: { id: source.sessionId },
      data: { nextEntrySeq: head.length + rest.length, headEntryId: "e5" },
    });

    const files = new Map<string, string>();
    const exported = await exportThreadSessions(prisma, source.threadId, async (id, lines) => {
      files.set(id, (files.get(id) ?? "") + lines);
    });
    expect(exported).toEqual([source.sessionId, child.id]);

    const target = await seedThread(prisma, "Grace");
    const imported = [...files].map(([sessionId, jsonl]) => ({ sessionId, jsonl }));
    await expect(importThreadSessions(prisma, target.threadId, imported)).resolves.toEqual({
      sessions: 2,
      entries: 12,
    });

    const entries = (
      await prisma.sessionEntry.findMany({
        where: { sessionId: target.sessionId },
        orderBy: { seq: "asc" },
      })
    ).map(sessionEntryFromRow);
    expect(entries.map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 0, type: "user.message" },
      { seq: 1, type: "run.started" },
      { seq: 2, type: "tool.call" },
      { seq: 3, type: "run.finished" },
      { seq: 4, type: "user.message" },
      { seq: 5, type: "run.started" },
      { seq: 6, type: "tool.call" },
      { seq: 7, type: "subagent" },
      { seq: 8, type: "assistant.text" },
      { seq: 9, type: "run.finished" },
    ]);
    expect(entries.map((entry) => entry.id)).not.toContain("e0");
    const [user, started, call, helper] = entries.slice(4);
    expect(started?.payload).toMatchObject({ trigger: { kind: "message", entryId: user?.id } });
    expect(started?.runId).not.toBe("run_files");
    const helperSession = (helper!.payload as { sessionId: string }).sessionId;
    expect(
      await prisma.conversationSession.findUniqueOrThrow({ where: { id: helperSession } }),
    ).toMatchObject({
      kind: "subagent",
      parentSessionId: target.sessionId,
      parentEntryId: call?.id,
    });
    const helperEntries = (
      await prisma.sessionEntry.findMany({
        where: { sessionId: helperSession },
        orderBy: { seq: "asc" },
      })
    ).map(sessionEntryFromRow);
    expect(helperEntries.map((entry) => entry.payload)).toEqual([
      { trigger: { kind: "subagent", entryId: call?.id }, model: MODEL, effort: null },
      { blocks: [{ kind: "text", text: "Acme." }] },
    ]);
    expect(
      await prisma.run.findMany({
        where: { threadId: target.threadId },
        orderBy: { startedAt: "asc" },
        select: {
          id: true,
          sessionId: true,
          status: true,
          trigger: true,
          sourceMessageId: true,
          modelId: true,
        },
      }),
    ).toEqual([
      {
        id: helperEntries[0]!.runId,
        sessionId: helperSession,
        status: "cancelled",
        trigger: "subagent",
        sourceMessageId: call!.id,
        modelId: "claude",
      },
      {
        id: entries[1]!.runId,
        sessionId: target.sessionId,
        status: "completed",
        trigger: "user",
        sourceMessageId: entries[0]!.id,
        modelId: "claude",
      },
      {
        id: started!.runId,
        sessionId: target.sessionId,
        status: "completed",
        trigger: "user",
        sourceMessageId: user!.id,
        modelId: "claude",
      },
    ]);

    const looped = (sessionId: string, child: string) =>
      `${JSON.stringify({
        id: `${sessionId}_0`,
        sessionId,
        seq: 0,
        parentId: null,
        ts: "2026-10-01T09:00:00.000Z",
        botId,
        runId: `${sessionId}_run`,
        type: "routine.started",
        payload: {
          sessionId: child,
          routineId: "routine_loop",
          name: "Loop",
          trigger: "routine",
          scheduledAt: "2026-10-01T09:00:00.000Z",
          model: MODEL,
        },
      })}\n`;
    const other = await seedThread(prisma, "Linus");
    await expect(
      importThreadSessions(prisma, other.threadId, [
        ...imported,
        { sessionId: "loop_a", jsonl: looped("loop_a", "loop_b") },
        { sessionId: "loop_b", jsonl: looped("loop_b", "loop_a") },
      ]),
    ).rejects.toThrow("does not reach the sessions loop_a, loop_b");

    await expect(importThreadSessions(prisma, target.threadId, imported)).rejects.toThrow(
      /already holds entries/,
    );
  });
});
