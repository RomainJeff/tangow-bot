import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, ConnectorCall } from "@rakazo/adapter-kit";
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
    /** Routines stored in this space. */
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
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        historyCompactionGeneration: 1,
      })),
      findFirst: vi.fn(async () => ({ groupId: null })),
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
    /** When the routine wake-ups were queued for. */
    wakeups: () =>
      enqueue.mock.calls.flatMap(([job]) =>
        job.name === "routine.wakeup" ? [job.availableAt] : [],
      ),
    askBlock,
    messageUpdate,
    /** The cards the run posted outside a pause, in order, with their nonces. */
    posted: () => postedCards().map((data) => data.blocks),
    nonces: () => postedCards().map((data) => data.clientNonce),
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
      expect(f.nonces()).toEqual(["routine-confirmation:effect-1"]);
      expect(f.results).toEqual([
        expect.objectContaining({ ok: true, routineId: "routine-new", schedule: "Every hour UTC" }),
      ]);
    },
  );

  it("posts its card once when the run is retried", async () => {
    const f = fixture();
    await f.play([[routine]]);
    await f.play([[routine]], "worker-2");
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.nonces()).toEqual(["routine-confirmation:effect-1"]);
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

  it("links the approval card the user allowed to the routine, with no second card", async () => {
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
      created: { kind: "routine", id: "routine-new", label: "Stretch" },
    });
  });
});
