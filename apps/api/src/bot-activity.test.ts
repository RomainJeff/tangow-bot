import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, BotActivityInput, BotActivityOutput, RunRecap } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

const at = (hour: number) => new Date(Date.UTC(2026, 9, 6, hour));

function runRow(id: string, createdAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id,
    botId: "bot-1",
    threadId: "thread-1",
    status: "completed",
    trigger: "routine",
    error: null,
    routineId: "routine-1",
    sourceMessageId: null,
    startedAt: createdAt,
    completedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    bot: { name: "Scout", archivedAt: null, notifyOnFinish: false },
    task: { prompt: "digest" },
    routine: { name: "Morning digest" },
    sourceMessage: null,
    thread: { groupId: null, group: null },
    ...overrides,
  };
}

type Where = Record<string, unknown>;

function setup({
  bot = { id: "bot-1", name: "Scout", createdAt: at(1) } as Record<string, unknown> | null,
  active = [] as unknown[],
  finished = [] as unknown[],
  routines = [] as unknown[],
  run = null as unknown,
  messages = [] as unknown[],
} = {}) {
  const prisma = {
    bot: {
      findFirst: vi.fn(async (_args: unknown) =>
        bot ? { ...bot, thread: null, computer: null } : null,
      ),
    },
    run: {
      findMany: vi.fn(async (args: { where: Where }) =>
        JSON.stringify(args.where).includes('"running"') ? active : finished,
      ),
      findFirst: vi.fn(async (_args: unknown) => run),
    },
    routine: { findMany: vi.fn(async (_args: unknown) => routines) },
    message: { findMany: vi.fn(async (_args: unknown) => messages) },
  };
  const handler = new RPCHandler(
    createRouter({ prisma: prisma as unknown as PrismaClient } as unknown as RouterDeps),
  );
  const call = async <T>(path: string, input: unknown) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response?.status, body: (await response?.json()) as { json: T } };
  };
  return {
    prisma,
    activity: (input: BotActivityInput) => call<BotActivityOutput>("bots/activity", input),
    recap: (runId: string) => call<RunRecap>("runs/recap", { runId }),
  };
}

const describeItem = (item: BotActivityOutput["items"][number]) =>
  item.kind === "routine_run"
    ? `${item.run.runId}:${item.run.status}`
    : item.kind === "routine_created"
      ? `created:${item.routineName}:${item.byBotName ?? "you"}`
      : `bot:${item.botName}`;

describe("bots.activity", () => {
  it("refuses a bot outside the caller's own bots and reads none of its activity", async () => {
    const { prisma, activity } = setup({ bot: null, finished: [runRow("r", at(5))] });
    const { status } = await activity({ botId: "bot-of-someone-else" });
    expect(status).toBe(500);
    expect(prisma.bot.findFirst.mock.calls[0]).toEqual([
      {
        where: {
          id: "bot-of-someone-else",
          spaceId: "space-1",
          userId: "user-1",
          archivedAt: null,
        },
        include: { thread: true, computer: true },
      },
    ]);
    expect(prisma.run.findMany).not.toHaveBeenCalled();
  });

  it("reads only this bot's routine runs and routines, inside the caller's space and user", async () => {
    const { prisma, activity } = setup();
    await activity({ botId: "bot-1" });
    const owner = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
    const routineRuns = {
      ...owner,
      OR: [{ routineId: { not: null } }, { trigger: "routine" }],
    };
    const runWheres = prisma.run.findMany.mock.calls.map(([args]) => args.where);
    expect(runWheres).toEqual([
      {
        ...routineRuns,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      { AND: [routineRuns, { status: { in: ["completed", "failed", "cancelled"] } }, {}] },
    ]);
    expect(prisma.routine.findMany.mock.calls[0]?.[0]).toMatchObject({ where: owner, take: 31 });
  });

  it("lists active runs, then runs and creations newest first, with the bot's creation last", async () => {
    const { body } = await setup({
      active: [runRow("live", at(9), { status: "running", completedAt: null })],
      finished: [
        runRow("done", at(8)),
        runRow("failed", at(4), { status: "failed", error: "Connect that model provider first" }),
      ],
      routines: [
        { id: "routine-2", name: "Inbox sweep", createdAt: at(6), threadId: "thread-1" },
        { id: "routine-1", name: "Morning digest", createdAt: at(3), threadId: null },
      ],
    }).activity({ botId: "bot-1" });
    expect(body.json.items.map(describeItem)).toEqual([
      "live:running",
      "done:completed",
      "created:Inbox sweep:Scout",
      "failed:failed",
      "created:Morning digest:you",
      "bot:Scout",
    ]);
    expect(body.json.nextCursor).toBeNull();
    const failed = body.json.items[3];
    expect(failed?.kind === "routine_run" && failed.run.failureKind).toBe("missing_model");
  });

  it("pages every kind of entry together on its creation time", async () => {
    const first = await setup({
      finished: [runRow("r3", at(7)), runRow("r2", at(5)), runRow("r1", at(2))],
      routines: [{ id: "routine-1", name: "Digest", createdAt: at(6), threadId: null }],
    }).activity({ botId: "bot-1", limit: 2 });
    expect(first.body.json.items.map(describeItem)).toEqual(["r3:completed", "created:Digest:you"]);
    const cursor = { createdAt: at(6).toISOString(), id: "routine-1" };
    expect(first.body.json.nextCursor).toEqual(cursor);

    const later = setup({ finished: [runRow("r2", at(5)), runRow("r1", at(2))] });
    const second = await later.activity({ botId: "bot-1", limit: 2, cursor });
    const keyset = {
      OR: [{ createdAt: { lt: at(6) } }, { createdAt: at(6), id: { lt: "routine-1" } }],
    };
    expect(later.prisma.run.findMany).toHaveBeenCalledTimes(1);
    expect(later.prisma.run.findMany.mock.calls[0]?.[0].where).toMatchObject({
      AND: [expect.anything(), expect.anything(), keyset],
    });
    expect(later.prisma.routine.findMany.mock.calls[0]?.[0]).toMatchObject({ where: keyset });
    expect(second.body.json.items.map(describeItem)).toEqual(["r2:completed", "r1:completed"]);
    expect(second.body.json.nextCursor).toEqual({ createdAt: at(2).toISOString(), id: "r1" });

    const last = await setup().activity({
      botId: "bot-1",
      limit: 2,
      cursor: second.body.json.nextCursor ?? undefined,
    });
    expect(last.body.json).toEqual({
      items: [
        { kind: "bot_created", botId: "bot-1", botName: "Scout", createdAt: at(1).toISOString() },
      ],
      nextCursor: null,
    });
  });

  it("leaves the bot's creation off a page that starts before it", async () => {
    const { body } = await setup().activity({
      botId: "bot-1",
      cursor: { createdAt: at(0).toISOString(), id: "zzz" },
    });
    expect(body.json).toEqual({ items: [], nextCursor: null });
  });
});

describe("runs.recap", () => {
  it("refuses a run outside the caller's space and user", async () => {
    const { prisma, recap } = setup({ run: null });
    const { status } = await recap("run-of-someone-else");
    expect(status).toBe(500);
    expect(prisma.run.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "run-of-someone-else", spaceId: "space-1", userId: "user-1" },
    });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("returns what the run said in its thread and the message to open", async () => {
    const { prisma, recap } = setup({
      run: { id: "run-1", threadId: "thread-1" },
      messages: [
        { id: "m1", blocks: [{ kind: "text", text: "**2 invoices** are late" }] },
        { id: "m2", blocks: [{ kind: "text", text: "Sent the reminders." }] },
      ],
    });
    const { body } = await recap("run-1");
    expect(body.json).toEqual({
      text: "**2 invoices** are late\n\nSent the reminders.",
      messageId: "m1",
    });
    expect(prisma.message.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { threadId: "thread-1", runId: "run-1", role: "bot" },
    });
  });

  it("keeps a message's text when it also holds a block this build does not know", async () => {
    const { recap } = setup({
      run: { id: "run-1", threadId: "thread-1" },
      messages: [
        { id: "m1", blocks: [{ kind: "text", text: "Sent the reminders." }, { kind: "hologram" }] },
      ],
    });
    const { body } = await recap("run-1");
    expect(body.json).toEqual({ text: "Sent the reminders.", messageId: "m1" });
  });
});
