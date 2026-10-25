import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import { SessionId } from "@rakazo/contracts";
import type { PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { applyMigration, migrationNames, openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSessionLog } from "./session-log/postgres.js";

const isWorkerMigration = (name: string) => name >= "20261019120000";
const USER = "user_migration";
const SPACE = "space_migration";

let database: PgliteDatabase;
let applyLater: (name: string) => Promise<void>;
let workerMigrations: string[];

beforeAll(async () => {
  const names = await migrationNames();
  workerMigrations = names.filter(isWorkerMigration);
  database = await openPgliteDatabase(async (created) => {
    applyLater = (name) => applyMigration(created, name);
    for (const name of names.filter((name) => !isWorkerMigration(name))) {
      await applyMigration(created, name);
    }
  });
});
afterAll(() => database.close());

/** Writes the rows an existing deployment holds, with SQL the previous schema accepts. */
async function seedExistingDeployment() {
  const { prisma } = database;
  await prisma.user.create({ data: { id: USER, name: "M", email: "migration@rakazo.test" } });
  await prisma.organization.create({
    data: { id: "org_migration", name: "M", slug: "org-migration", createdAt: new Date() },
  });
  await prisma.$executeRaw`INSERT INTO spaces (id, "organizationId", name)
    VALUES (${SPACE}, 'org_migration', 'M')`;
  for (const [id, scope, kind] of [
    ["computer_team", "team", "e2b"],
    ["computer_dedicated", "dedicated", "docker"],
  ]) {
    await prisma.$executeRaw`INSERT INTO computers (id, "spaceId", "userId", scope, "scopeKey",
      "homeKey", kind, "updatedAt") VALUES (${id}, ${SPACE}, ${USER}, ${scope}, ${id}, ${id},
      ${kind}, now())`;
  }
  const bot = await prisma.bot.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      name: "Ada",
      color: "#00C46A",
      computerId: "computer_team",
    },
  });
  await prisma.bot.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      name: "Bob",
      color: "#00C46A",
      computerId: "computer_dedicated",
    },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: SPACE,
      botId: bot.id,
      threadId: thread.id,
      userId: USER,
      prompt: "",
      status: "completed",
    },
  });
  const run = await prisma.run.create({
    data: {
      id: "run_migration",
      spaceId: SPACE,
      botId: bot.id,
      threadId: thread.id,
      taskId: task.id,
      userId: USER,
      status: "completed",
      trigger: "user",
      leaseFence: 2,
    },
  });
  for (const [id, fence, status] of [
    ["attempt_one", 1, "interrupted"],
    ["attempt_two", 2, "completed"],
  ] as const) {
    await prisma.$executeRaw`INSERT INTO attempts (id, "runId", fence, status)
      VALUES (${id}, ${run.id}, ${fence}, ${status})`;
  }

  const log = new PostgresSessionLog(prisma);
  const sessionId = SessionId.parse(thread.sessionId);
  const childId = SessionId.parse("session_migration_child");
  const ofRun = { sessionId, runId: run.id, botId: bot.id };
  const append = (draft: SessionEntryDraft) =>
    prisma.$transaction((tx) => log.append(tx, { ...draft, feedBotId: bot.id }));
  await append({
    sessionId,
    type: "user.message",
    payload: { blocks: [{ kind: "text", text: "summarize the notes" }], source: "app" },
  });
  const delegated = await append({
    ...ofRun,
    type: "tool.call",
    payload: { callId: "call_1", name: "subagent", input: "{}" },
  });
  await prisma.$transaction((tx) =>
    log.createSession(tx, {
      kind: "subagent",
      id: childId,
      spaceId: SPACE,
      parentSessionId: sessionId,
      parentEntryId: delegated.id,
    }),
  );
  await append({
    sessionId: childId,
    runId: run.id,
    botId: bot.id,
    type: "assistant.text",
    payload: { blocks: [{ kind: "text", text: "child found three notes" }] },
  });
  await append({
    ...ofRun,
    type: "assistant.text",
    payload: { blocks: [{ kind: "text", text: "Three notes, all done." }] },
  });
  return { log, sessionId, childId, runId: run.id };
}

describe("worker and volume migrations", () => {
  it("leave existing sessions, runs, attempts and homes as they were", async () => {
    const { log, sessionId, childId, runId } = await seedExistingDeployment();
    const read = async () => ({
      thread: await log.readTail(sessionId),
      child: await log.readTail(childId),
      run: await log.readRun(runId),
    });
    const before = await read();

    for (const name of workerMigrations) await applyLater(name);

    expect(before.thread.map((entry) => entry.type)).toEqual([
      "user.message",
      "tool.call",
      "assistant.text",
    ]);
    expect([before.child.length, before.run.length]).toEqual([1, 3]);
    expect(await read()).toEqual(before);
    expect(
      await database.prisma.attempt.findMany({
        select: { id: true, workerState: true },
        orderBy: { fence: "asc" },
      }),
    ).toEqual([
      { id: "attempt_one", workerState: null },
      { id: "attempt_two", workerState: null },
    ]);
    expect(
      await database.prisma.computer.findMany({
        select: { id: true, homeStorage: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual([
      { id: "computer_dedicated", homeStorage: "snapshot" },
      { id: "computer_team", homeStorage: "snapshot" },
    ]);
  });
});
