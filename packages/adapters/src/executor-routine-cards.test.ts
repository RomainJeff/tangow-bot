import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, ConnectorCall } from "@rakazo/adapter-kit";
import { BOT_MESSAGE_MAX_HOPS } from "@rakazo/core";
import { Prisma } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import { runAutoReviewJudge } from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  updatedAt?: Date;
  answeredAt?: Date;
  createdAt?: Date;
};
type EffectWhere = Partial<Record<keyof Effect, unknown>>;

/**
 * Equality, `{ gte }` on dates, `{ in }`, `{ not }`, `OR`, a JSON null and a JSON path; relation
 * filters are ignored: every effect is bot-1's, in thread-1.
 */
const effectMatches = (effect: Effect, where: EffectWhere = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === "run") return true;
    if (key === "OR")
      return (value as EffectWhere[]).some((option) => effectMatches(effect, option));
    const actual = effect[key as keyof Effect];
    if (value && typeof value === "object" && "gte" in value) {
      return actual instanceof Date && actual >= (value as { gte: Date }).gte;
    }
    if (value && typeof value === "object" && "in" in value) {
      return (value as { in: unknown[] }).in.includes(actual);
    }
    if (value && typeof value === "object" && "not" in value) {
      const not = (value as { not: unknown }).not;
      return not === null ? actual != null : actual !== not;
    }
    if (value && typeof value === "object" && "path" in value) {
      const { path: keys, equals } = value as { path: string[]; equals: unknown };
      return keys.reduce<unknown>((at, part) => (at as Row | undefined)?.[part], actual) === equals;
    }
    if (value && typeof value === "object" && "equals" in value) {
      return (value as { equals: unknown }).equals === Prisma.AnyNull && actual == null;
    }
    return actual === value;
  });

const inThread = (effect: Effect) => ({ ...effect, run: { threadId: "thread-1" } });

type ToolCall = { name: string; args: Record<string, unknown> };
type Row = Record<string, unknown>;

const routine = {
  name: "schedule_create",
  args: { name: "Stretch", prompt: "Remind me to stretch", every: 1, unit: "hours" },
};

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-routine-cards-"));
  vi.mocked(runAutoReviewJudge).mockReset();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function table(store: Row[]) {
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  return {
    findMany: vi.fn(async ({ where = {} }: { where?: Row } = {}) =>
      store.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: Record<string, Row> }) =>
        store.find((row) => matches(row, Object.values(where)[0] ?? {})) ?? null,
    ),
    upsert: vi.fn(async ({ where, create }: { where: Record<string, Row>; create: Row }) => {
      const key = Object.values(where)[0] ?? {};
      const found = store.find((row) => matches(row, key));
      if (found) return found;
      store.push({ ...create });
      return create;
    }),
  };
}

function fixture(
  options: {
    trigger?: string;
    requireToolApproval?: boolean;
    groupId?: string;
    /** Routines stored in this space, any bot's; `threadGroupId` is the group of their thread. */
    routines?: Row[];
    /** The routine whose wake started the run. */
    routineId?: string;
  } = {},
) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const run: Row = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? "user",
    sourceMessageId: null,
    routineId: options.routineId ?? null,
    requireToolApproval: options.requireToolApproval ?? true,
    leaseFence: 0,
    createdAt: new Date(),
  };
  const routineCreate = vi.fn(async ({ data }: { data: Row }) => ({ id: "routine-new", ...data }));
  const routines = (options.routines ?? []).map((row) => ({ ...row }));
  // Like Prisma, a field set to undefined is left as stored.
  const routineUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => ({
    ...Object.assign(
      routines.find((row) => row.id === where.id)!,
      Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    ),
  }));
  const routineMatches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) =>
      key === "OR"
        ? (value as Row[]).some((option) => routineMatches(row, option))
        : key === "thread"
          ? (row.threadGroupId ?? null) === (value as Row).groupId
          : row[key] === value,
    );
  const externalEffect = {
    findMany: vi.fn(async ({ where }: { where?: EffectWhere } = {}) =>
      effects.filter((effect) => effectMatches(effect, where)).map(inThread),
    ),
    findFirst: vi.fn(async ({ where }: { where: EffectWhere }) => {
      const found = effects.find((effect) => effectMatches(effect, where));
      return found ? inThread(found) : null;
    }),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { createdAt: new Date(), ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const messages: Row[] = [];
  const skillSetting = table([]);
  const botSkill = table([]);
  const messageUpdate = vi.fn(async () => undefined);
  const messageCreate = vi.fn(async ({ data }: { data: Row }) => ({ id: "message-new", ...data }));
  const send = vi.fn(async () => undefined);
  const prisma: Row = {
    $transaction: vi.fn(async (ops: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof ops === "function" ? ops(prisma) : Promise.all(ops),
    ),
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => run),
      // The waiting run a proposal checks for, or the notification source of a push.
      findFirst: vi.fn(async ({ where, select }: { where: Row; select: Row }) => {
        if (where.status === "waiting_input") return null;
        return select.bot ? { bot: { notifyOnFinish: true }, thread: { groupId: null } } : null;
      }),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Row }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "bot-1",
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "thread-1",
        groupId: options.groupId ?? null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        historyCompactionGeneration: 1,
      })),
      findFirst: vi.fn(async () => ({ groupId: options.groupId ?? null })),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({ nextEventSeq: 2, nextMessageSeq: 2 })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Row }) => ({ ...data, threadId: "thread-1" })),
      findFirst: vi.fn(async () => null),
    },
    chatGroup: {
      findUnique: vi.fn(async () => ({ name: "Trip", description: "", members: [] })),
    },
    message: {
      update: messageUpdate,
      create: messageCreate,
      findMany: vi.fn(async () => messages),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          messages.find((message) => message.id === where.id) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          messages.find((message) => message.id === where.id) ?? null,
      ),
    },
    routine: {
      create: routineCreate,
      update: routineUpdate,
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = routines.find((stored) => routineMatches(stored, where));
        return row ? { ...row } : null;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          routines.find((row) => row.id === where.id) ?? null,
      ),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "Remind me to stretch" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    skillSetting,
    botSkill,
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: {
      findUnique: vi.fn(async () => ({ enabled: false })),
    },
    externalEffect,
  };
  const enqueue = vi.fn(async (_job: { name: string; availableAt: Date }) => undefined);
  const cancel = vi.fn(async (_key: string) => undefined);
  const pauseRunForInput = vi.fn(async (_input: { blocks: unknown[] }) => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let batches: ToolCall[][] = [];
  // Mirrors Pi's parallel batch: every call of a turn is announced before any of them runs.
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    await request.claimSteering?.([]);
    for (const batch of batches) {
      const settled = await Promise.all(
        batch.map((call, index) =>
          request.executeTool!(call.name, call.args, `${call.name}-${results.length + index}`),
        ),
      );
      results.push(...settled);
      if (settled.some(isApprovalPausedResult)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    notifications: { send },
    events: {
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      pauseRunForInput,
      finalizeRun,
      claimSteering: vi.fn(async () => []),
    },
    jobs: { enqueue, cancel },
    secrets: [],
    dataDir,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const postedCards = () =>
    messageCreate.mock.calls
      .map(([{ data }]) => data)
      .filter((data) => (data.blocks as Row[]).some((block) => block.kind === "ask"));
  const askBlock = () =>
    (pauseRunForInput.mock.calls[0]?.[0] as { blocks: unknown[] } | undefined)?.blocks[0];
  return {
    run,
    effects,
    messages,
    results,
    routineCreate,
    routineUpdate,
    routines,
    /** When the routine wake-ups were queued for. */
    wakeups: () =>
      enqueue.mock.calls.flatMap(([job]) =>
        job.name === "routine.wakeup" ? [job.availableAt] : [],
      ),
    askBlock,
    messageUpdate,
    /** The cards the run posted outside a pause, in order. */
    posted: () => postedCards().map((data) => data.blocks),
    async play(next: ToolCall[][], workerId = "worker-1", ends: "ok" | "failed" = "ok") {
      batches = next;
      run.status = "queued";
      await executor.continueRun("run-1", workerId);
      expect(runtimeRun).toHaveBeenCalled();
      const failed = expect.objectContaining({ outcome: "failed" });
      if (ends === "ok") expect(finalizeRun).not.toHaveBeenCalledWith(failed);
      else expect(finalizeRun).toHaveBeenCalledWith(failed);
    },
  };
}

describe("a routine the user asks for", () => {
  const confirmation = {
    kind: "ask",
    approvalEffectId: "effect-1",
    text: "Every hour UTC",
    status: "answered",
    routine: {
      name: "Stretch",
      schedule: "Every hour UTC",
      prompt: "Remind me to stretch",
      notify: false,
    },
    created: { kind: "routine", id: "routine-new", label: "Stretch" },
    confirms: "created",
  };
  const inbox = {
    id: "routine-wake",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    name: "Inbox",
    prompt: "Sort what arrives",
    crons: [],
    timezone: "UTC",
    webhookEnabled: true,
    notify: false,
    active: true,
    inheritedHop: null,
  };

  it.each([
    ["the user", { trigger: "user" }],
    [
      "a webhook whose routine acts without approval",
      {
        trigger: "webhook",
        requireToolApproval: false,
        routineId: "routine-wake",
        routines: [inbox],
      },
    ],
    ["a messaging contact", { trigger: "messaging" }],
  ])(
    "is set up directly in a run started by %s, with a card saying what was set up",
    async (_label, options) => {
      const f = fixture(options);
      await f.play([[routine]]);
      expect(f.routineCreate).toHaveBeenCalledOnce();
      expect(f.askBlock()).toBeUndefined();
      expect(f.posted()).toEqual([[expect.objectContaining(confirmation)]]);
      expect(f.results).toEqual([
        expect.objectContaining({ ok: true, routineId: "routine-new", schedule: "Every hour UTC" }),
      ]);
    },
  );

  it("replays the routine already set up when the run repeats the call, with no second card", async () => {
    const f = fixture();
    await f.play([[routine]]);
    await f.play([[routine]], "worker-2");
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.posted()).toEqual([[expect.objectContaining(confirmation)]]);
    expect(f.results).toEqual([
      expect.objectContaining({ ok: true, routineId: "routine-new" }),
      expect.objectContaining({ ok: true, routineId: "routine-new" }),
    ]);
  });

  it("posts no confirmation when the routine could not be set up", async () => {
    const f = fixture();
    await f.play([[{ ...routine, args: { ...routine.args, every: 0 } }]]);
    expect(f.results).toEqual([{ error: "every must be a positive whole number." }]);
    expect(f.posted()).toEqual([]);
  });

  it.each([
    ["name", { prompt: "Remind me to stretch" }, "name is required."],
    ["prompt", { name: "Stretch", prompt: "  " }, "prompt is required."],
  ])("still needs a %s to create one", async (_field, args, error) => {
    const f = fixture();
    await f.play([[{ name: "schedule_create", args: { ...args, every: 1, unit: "hours" } }]]);
    expect(f.results).toEqual([{ error }]);
    expect(f.routineCreate).not.toHaveBeenCalled();
  });

  it.each([null, ""])("is set up when the model sends %j as its routineId", async (routineId) => {
    const f = fixture();
    await f.play([[{ ...routine, args: { ...routine.args, routineId, runAt: null } }]]);
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.results).toEqual([
      expect.objectContaining({ ok: true, routineId: "routine-new", schedule: "Every hour UTC" }),
    ]);
  });

  it("refuses an unknown time zone before anything is stored", async () => {
    const f = fixture();
    await f.play([
      [
        {
          ...routine,
          args: { name: "Pay rent", prompt: "Pay rent", delayMinutes: 5, timezone: "Mars/Olympus" },
        },
      ],
    ]);
    expect(f.results).toEqual([
      { error: "timezone must be an IANA time zone, such as Europe/Paris." },
    ]);
    expect(f.routineCreate).not.toHaveBeenCalled();
    expect(f.wakeups()).toEqual([]);
    expect(f.posted()).toEqual([]);
  });

  it("settles the approval card the user allowed on the routine, with no second card", async () => {
    const f = fixture({ trigger: "webhook", routineId: "routine-wake", routines: [inbox] });
    await f.play([[routine]]);
    const card = f.askBlock() as Row;
    expect(card).toMatchObject({ kind: "ask", approvalEffectId: "effect-1" });
    expect(f.routineCreate).not.toHaveBeenCalled();
    f.messages.push({
      id: "m-card",
      threadId: "thread-1",
      seq: 2,
      role: "bot",
      runId: "run-1",
      botId: "bot-1",
      blocks: [{ ...card, status: "answered", answer: "allow" }],
    });
    f.effects[0]!.status = "approved";
    await f.play([[routine]]);
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.posted()).toEqual([]);
    expect(
      (f.messageUpdate.mock.calls[0] as unknown as [{ data: { blocks: Row[] } }])[0].data.blocks[0],
    ).toMatchObject({
      approvalEffectId: "effect-1",
      answer: "allow",
      text: "Every hour UTC",
      routine: confirmation.routine,
      created: { kind: "routine", id: "routine-new", label: "Stretch" },
      confirms: "created",
    });
  });
});

describe("a routine the user asks to change", () => {
  const stored = {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    name: "Stretch",
    prompt: "Remind me to stretch",
    crons: ["0 * * * *"],
    timezone: "UTC",
    notify: false,
    active: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: false,
    inheritedHop: null,
    lastRunAt: null,
    nextRunAt: new Date("2030-01-01T00:00:00Z"),
  };
  const change = (args: Record<string, unknown>) => ({
    name: "schedule_create",
    args: { routineId: "routine-1", ...args },
  });
  const at = async <T>(now: string, test: () => Promise<T>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    try {
      return await test();
    } finally {
      vi.useRealTimers();
    }
  };

  it("changes this bot's routine and shows Routine updated, the schedule it now keeps", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const f = fixture({ routines: [stored] });
      await f.play([
        [
          change({
            prompt: "Remind me to stretch and drink",
            cron: "0 9 * * *",
            timezone: "Europe/Paris",
          }),
        ],
      ]);
      expect(f.routineCreate).not.toHaveBeenCalled();
      expect(f.routines[0]).toMatchObject({
        name: "Stretch",
        prompt: "Remind me to stretch and drink",
        crons: ["0 9 * * *"],
        timezone: "Europe/Paris",
      });
      expect(f.wakeups()).toEqual([new Date("2026-10-08T07:00:00Z")]);
      expect(f.posted()).toEqual([
        [
          expect.objectContaining({
            text: "Every day at 09:00 Europe/Paris",
            status: "answered",
            routine: {
              name: "Stretch",
              schedule: "Every day at 09:00 Europe/Paris",
              prompt: "Remind me to stretch and drink",
              notify: false,
            },
            created: { kind: "routine", id: "routine-1", label: "Stretch" },
            confirms: "updated",
          }),
        ],
      ]);
    }));

  it("keeps the name, instruction and schedule it is not asked to change", async () => {
    const f = fixture({ routines: [stored] });
    await f.play([[change({ notify: true })]]);
    expect(f.routines[0]).toMatchObject({
      name: "Stretch",
      prompt: "Remind me to stretch",
      crons: ["0 * * * *"],
      notify: true,
      nextRunAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(f.wakeups()).toEqual([]);
    expect(f.posted()).toEqual([
      [expect.objectContaining({ text: "Every hour UTC", confirms: "updated" })],
    ]);
  });

  it("runs a reminder that already ran again at the new time, and asks for one otherwise", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const ran = {
        ...stored,
        name: "Pay rent",
        crons: ["@once"],
        active: false,
        nextRunAt: null,
        lastRunAt: new Date("2026-10-06T08:00:00Z"),
      };
      const renamed = fixture({ routines: [ran] });
      await renamed.play([[change({ name: "Pay the rent" })]]);
      expect(renamed.results).toEqual([
        { error: "This reminder already ran: give it a new time to run it again." },
      ]);
      expect(renamed.routineUpdate).not.toHaveBeenCalled();

      const f = fixture({ routines: [ran] });
      await f.play([[change({ runAt: "2026-10-08T08:00:00Z" })]]);
      expect(f.routines[0]).toMatchObject({
        crons: ["@once"],
        active: true,
        nextRunAt: new Date("2026-10-08T08:00:00Z"),
      });
      expect(f.wakeups()).toEqual([new Date("2026-10-08T08:00:00Z")]);
      expect(f.posted()).toEqual([
        [expect.objectContaining({ text: "Once on Oct 8, 2026 at 08:00 UTC" })],
      ]);
    }));

  it("keeps a paused routine paused, and says so to the bot and on the card", async () => {
    const f = fixture({ routines: [{ ...stored, active: false, nextRunAt: null }] });
    await f.play([[change({ cron: "0 9 * * *" })]]);
    expect(f.routines[0]).toMatchObject({ crons: ["0 9 * * *"], active: false, nextRunAt: null });
    expect(f.wakeups()).toEqual([]);
    expect(f.results).toEqual([
      expect.objectContaining({
        ok: true,
        schedule: "Every day at 09:00 UTC · paused",
        paused: true,
        note: "This routine is paused: it will not run until the user resumes it in the app. Tell them.",
      }),
    ]);
    expect(f.posted()).toEqual([
      [expect.objectContaining({ text: "Every day at 09:00 UTC · paused" })],
    ]);
  });

  it("settles the approval card the user allowed on the routine it changed", async () => {
    const wake = {
      ...stored,
      id: "routine-wake",
      crons: [],
      webhookEnabled: true,
      nextRunAt: null,
    };
    const f = fixture({ trigger: "webhook", routineId: "routine-wake", routines: [wake, stored] });
    await f.play([[change({ notify: true })]]);
    const card = f.askBlock() as Row;
    expect(card).toMatchObject({ kind: "ask", approvalEffectId: "effect-1" });
    f.messages.push({
      id: "m-card",
      threadId: "thread-1",
      seq: 2,
      role: "bot",
      runId: "run-1",
      botId: "bot-1",
      blocks: [{ ...card, status: "answered", answer: "allow" }],
    });
    f.effects[0]!.status = "approved";
    await f.play([[change({ notify: true })]]);
    expect(f.posted()).toEqual([]);
    expect(
      (f.messageUpdate.mock.calls[0] as unknown as [{ data: { blocks: Row[] } }])[0].data.blocks[0],
    ).toMatchObject({
      answer: "allow",
      text: "Every hour UTC",
      created: { kind: "routine", id: "routine-1", label: "Stretch" },
      confirms: "updated",
    });
  });

  it("names the trigger of a routine a webhook wakes on its card", async () => {
    const hook = { ...stored, crons: [], webhookEnabled: true, nextRunAt: null };
    const f = fixture({ routines: [hook] });
    await f.play([[change({ prompt: "Sort what arrives" })]]);
    expect(f.routines[0]).toMatchObject({
      crons: [],
      webhookEnabled: true,
      prompt: "Sort what arrives",
    });
    expect(f.posted()).toEqual([
      [expect.objectContaining({ text: "When a webhook fires", confirms: "updated" })],
    ]);
  });

  it("keeps every field the model sends as null as stored", async () => {
    const f = fixture({ routines: [stored] });
    await f.play([
      [
        change({
          name: "Stretch more",
          prompt: null,
          cron: null,
          every: null,
          unit: null,
          runAt: null,
          delayMinutes: null,
          delaySeconds: null,
          timezone: null,
          notify: null,
        }),
      ],
    ]);
    expect(f.results).toEqual([expect.objectContaining({ ok: true, name: "Stretch more" })]);
    expect(f.routines[0]).toMatchObject({
      name: "Stretch more",
      prompt: "Remind me to stretch",
      crons: ["0 * * * *"],
      timezone: "UTC",
      notify: false,
    });
  });

  it("moves every schedule of a routine to a new zone, and leaves several schedules to the app", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const twice = { ...stored, crons: ["0 9 * * 1-5", "0 10 * * 0,6"] };
      const f = fixture({ routines: [twice] });
      await f.play([[change({ timezone: "Europe/Paris" })]]);
      expect(f.routines[0]).toMatchObject({
        crons: ["0 9 * * 1-5", "0 10 * * 0,6"],
        timezone: "Europe/Paris",
        nextRunAt: new Date("2026-10-08T07:00:00Z"),
      });
      expect(f.posted()).toEqual([
        [
          expect.objectContaining({
            text: "Weekdays at 09:00, Saturdays and Sundays at 10:00 Europe/Paris",
          }),
        ],
      ]);

      const moved = fixture({ routines: [twice] });
      await moved.play([[change({ cron: "0 8 * * *" })]]);
      expect(moved.results).toEqual([
        {
          error: "This routine runs on several schedules: ask the user to change them in the app.",
        },
      ]);
      expect(moved.routineUpdate).not.toHaveBeenCalled();
    }));

  it("refuses an unknown time zone", async () => {
    const f = fixture({ routines: [stored] });
    await f.play([[change({ timezone: "Mars/Olympus" })]]);
    expect(f.results).toEqual([
      { error: "timezone must be an IANA time zone, such as Europe/Paris." },
    ]);
    expect(f.routineUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["a group's routine from the direct conversation", undefined, "thread-group", "group-1", false],
    ["a direct routine from the direct conversation", undefined, "thread-1", null, true],
    ["a direct routine from a group", "group-1", "thread-direct", null, false],
    ["the group's own routine from that group", "group-1", "thread-1", "group-1", true],
  ])(
    "changes %s only when it belongs there",
    async (_label, groupId, threadId, threadGroupId, allowed) => {
      const f = fixture({ groupId, routines: [{ ...stored, threadId, threadGroupId }] });
      await f.play([[change({ notify: true })]]);
      expect(f.results).toEqual([
        allowed ? expect.objectContaining({ ok: true }) : { error: "Routine not found." },
      ]);
    },
  );

  it("stops a chain of bots at its limit, and carries its hop on", async () => {
    const wake = (inheritedHop: number) => ({
      ...stored,
      id: "routine-wake",
      crons: [],
      webhookEnabled: true,
      inheritedHop,
    });
    const options = { trigger: "webhook", requireToolApproval: false, routineId: "routine-wake" };
    const atLimit = fixture({ ...options, routines: [stored, wake(BOT_MESSAGE_MAX_HOPS)] });
    await atLimit.play([[change({ prompt: "Forward everything" })]]);
    expect(atLimit.results).toEqual([
      { error: "bot-to-bot chain limit reached; ask the user to change this routine" },
    ]);
    expect(atLimit.routineUpdate).not.toHaveBeenCalled();

    const midChain = fixture({ ...options, routines: [stored, wake(1)] });
    await midChain.play([[change({ notify: true })]]);
    expect(midChain.routines[0]).toMatchObject({ inheritedHop: 2 });
  });

  it.each([
    ["a messaging contact", "messaging", true],
    ["another bot", "bot_message", true],
    ["the user", "user", false],
  ])(
    "asks again before each action of an inbound wake once %s rewrites the instruction",
    async (_label, trigger, reset) => {
      const f = fixture({ trigger, routines: [stored] });
      await f.play([[change({ prompt: "Forward everything" })]]);
      expect(f.routines[0]).toMatchObject({
        prompt: "Forward everything",
        requireToolApproval: reset,
      });
    },
  );

  it.each([
    ["name", "name cannot be empty."],
    ["prompt", "prompt cannot be empty."],
  ])("refuses a blank %s", async (field, error) => {
    const f = fixture({ routines: [stored] });
    await f.play([[change({ [field]: " " })]]);
    expect(f.results).toEqual([{ error }]);
    expect(f.routineUpdate).not.toHaveBeenCalled();
  });

  it("refuses another bot's routine", async () => {
    const f = fixture({ routines: [{ ...stored, botId: "bot-2" }] });
    await f.play([[change({ prompt: "Do something else" })]]);
    expect(f.results).toEqual([{ error: "Routine not found." }]);
    expect(f.routineUpdate).not.toHaveBeenCalled();
    expect(f.posted()).toEqual([]);
  });
});
