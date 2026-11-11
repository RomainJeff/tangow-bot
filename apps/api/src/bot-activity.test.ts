import { RPCHandler } from "@orpc/server/fetch";
import type {
  Actor,
  BotActivityInput,
  BotActivityOutput,
  RunRecap,
  SessionEntry,
} from "@tangow/contracts";
import { SessionEntrySchema } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { IsolationError } from "@tangow/db";
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
  entries = [] as SessionEntry[],
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
    $queryRaw: vi.fn(async () => []),
  };
  const sessionLog = {
    readRun: vi.fn(async (_runId: string, { limit }: { limit?: number } = {}) =>
      limit === undefined ? entries : entries.slice(-limit),
    ),
  };
  const handler = new RPCHandler(
    createRouter({
      prisma: prisma as unknown as PrismaClient,
      sessionLog,
    } as unknown as RouterDeps),
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
    sessionLog,
    activity: (input: BotActivityInput) => call<BotActivityOutput>("bots/activity", input),
    recap: (runId: string) => call<RunRecap>("runs/recap", { runId }),
    entries: (runId: string) =>
      call<{ entries: SessionEntry[]; truncated?: true }>("runs/entries", { runId }),
    sessionEntries: (sessionId: string) =>
      call<{ entries: SessionEntry[] }>("sessions/entries", { sessionId }),
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
    expect(status).toBe(404);
    expect(prisma.bot.findFirst.mock.calls[0]).toEqual([
      {
        where: {
          id: "bot-of-someone-else",
          spaceId: "space-1",
          userId: "user-1",
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

  it("reads every run of the bot but helper runs when asked for all", async () => {
    const { prisma, activity } = setup();
    await activity({ botId: "bot-1", allRuns: true });
    const botRuns = { spaceId: "space-1", userId: "user-1", botId: "bot-1", parentRunId: null };
    const runWheres = prisma.run.findMany.mock.calls.map(([args]) => args.where);
    expect(runWheres[1]).toEqual({
      AND: [botRuns, { status: { in: ["completed", "failed", "cancelled"] } }, {}],
    });
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

  it("lists only one routine's runs for its page, without creations, inside the caller's own bot", async () => {
    const { prisma, activity } = setup({
      active: [runRow("live", at(9), { status: "running", completedAt: null })],
      finished: [runRow("done", at(8))],
      routines: [{ id: "routine-1", name: "Morning digest", createdAt: at(3), threadId: null }],
    });
    const { body } = await activity({ botId: "bot-1", routineId: "routine-1" });
    expect(body.json.items.map(describeItem)).toEqual(["live:running", "done:completed"]);
    expect(body.json.nextCursor).toBeNull();
    const routineRuns = {
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      routineId: "routine-1",
    };
    expect(prisma.run.findMany.mock.calls.map(([args]) => args.where)).toEqual([
      {
        ...routineRuns,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      { AND: [routineRuns, { status: { in: ["completed", "failed", "cancelled"] } }, {}] },
    ]);
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
  });
});

const runEntry = (seq: number, type: string, payload: object): SessionEntry =>
  SessionEntrySchema.parse({
    id: `entry-${seq}`,
    sessionId: "session-routine",
    seq,
    parentId: seq === 0 ? null : `entry-${seq - 1}`,
    ts: at(9 + seq).toISOString(),
    botId: "bot-1",
    runId: "run-1",
    type,
    payload,
  });

const ranDigest = [
  runEntry(0, "run.started", {
    trigger: { kind: "direct" },
    model: { provider: "scripted", id: "scripted" },
    effort: null,
  }),
  runEntry(1, "assistant.text", { blocks: [{ kind: "text", text: "**2 invoices** are late" }] }),
  runEntry(2, "tool.call", { callId: "call-1", name: "send_email", input: "{}" }),
  runEntry(3, "tool.result", { callId: "call-1", output: "sent", isError: false, artifactIds: [] }),
  runEntry(4, "assistant.text", { blocks: [{ kind: "text", text: "Sent the reminders." }] }),
];

describe("runs.recap", () => {
  it("refuses a run outside the caller's space and user, and reads none of its entries", async () => {
    const { prisma, sessionLog, recap } = setup({ run: null, entries: ranDigest });
    const { status } = await recap("run-of-someone-else");
    expect(status).toBe(404);
    expect(prisma.run.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "run-of-someone-else", spaceId: "space-1", userId: "user-1" },
    });
    expect(sessionLog.readRun).not.toHaveBeenCalled();
  });

  it("returns what the run said from its entries and the entry to open", async () => {
    const { recap } = setup({ run: { id: "run-1" }, entries: ranDigest });
    const { body } = await recap("run-1");
    expect(body.json).toEqual({
      text: "**2 invoices** are late\n\nSent the reminders.",
      messageId: "entry-1",
    });
  });

  it("opens a routine run at its line in the thread, its report when it wrote no message", async () => {
    const routineRun = (...middle: SessionEntry[]) => [
      runEntry(0, "routine.started", {
        sessionId: "session-routine",
        routineId: "routine-1",
        name: "Digest",
        trigger: "routine",
        scheduledAt: at(9).toISOString(),
        model: { provider: "scripted", id: "scripted" },
      }),
      ...middle,
      runEntry(5, "routine.finished", {
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 1 },
        result: "Three new invoices",
      }),
    ];
    const read = async (entries: SessionEntry[]) =>
      (await setup({ run: { id: "run-1" }, entries }).recap("run-1")).body.json;
    expect(await read(routineRun())).toEqual({ text: "Three new invoices", messageId: "entry-0" });
    expect(await read(routineRun(ranDigest[1]!))).toEqual({
      text: "**2 invoices** are late",
      messageId: "entry-0",
    });
  });

  it("opens a failed routine run at its line, and no run the thread draws nothing for", async () => {
    const started = runEntry(0, "routine.started", {
      sessionId: "session-routine",
      routineId: "routine-1",
      name: "Digest",
      trigger: "routine",
      scheduledAt: at(9).toISOString(),
      model: { provider: "scripted", id: "scripted" },
    });
    const ended = (outcome: Record<string, unknown>) => [
      started,
      runEntry(1, "routine.finished", {
        usage: { inputTokens: 1, outputTokens: 1 },
        result: "",
        ...outcome,
      }),
    ];
    const target = async (entries: SessionEntry[]) =>
      (await setup({ run: { id: "run-1" }, entries }).recap("run-1")).body.json.messageId;
    expect(
      await Promise.all(
        [
          ended({ status: "failed", error: "boom" }),
          ended({ status: "completed", result: " \n" }),
          ended({ status: "cancelled", result: "Half done" }),
          [started],
        ].map(target),
      ),
    ).toEqual(["entry-0", null, null, null]);
  });
});

describe("runs.entries", () => {
  it("returns the caller's own run's entries and refuses anyone else's", async () => {
    const own = setup({ run: { id: "run-1" }, entries: ranDigest });
    const foreign = setup({ run: null, entries: ranDigest });

    const { body } = await own.entries("run-1");
    const { status } = await foreign.entries("run-1");

    expect(body.json.entries.map((entry) => entry.id)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2",
      "entry-3",
      "entry-4",
    ]);
    expect(status).toBe(404);
  });

  it("keeps a long run's newest entries and says it cut the oldest", async () => {
    const long = Array.from({ length: 1001 }, (_, seq) =>
      runEntry(seq, "assistant.text", { blocks: [{ kind: "text", text: `step ${seq}` }] }),
    );
    const { entries } = setup({ run: { id: "run-1" }, entries: long });

    const { body } = await entries("run-1");

    expect([body.json.entries.length, body.json.entries[0]?.id, body.json.truncated]).toEqual([
      1000,
      "entry-1",
      true,
    ]);
  });
});

describe("sessions.entries", () => {
  it("answers a session outside the caller's space as not found", async () => {
    const { sessionLog, sessionEntries } = setup({ entries: ranDigest });

    const { status } = await sessionEntries("session-of-someone-else");

    expect(status).toBe(404);
    expect(sessionLog.readRun).not.toHaveBeenCalled();
  });
});

describe("router errors", () => {
  it("keeps a server invariant an internal error without its internal text", async () => {
    const { prisma, recap } = setup();
    prisma.run.findFirst.mockRejectedValueOnce(new IsolationError("Bot is missing its thread"));

    const { status, body } = await recap("run-1");

    expect(status).toBe(500);
    expect(body.json).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(JSON.stringify(body)).not.toContain("missing its thread");
  });
});
