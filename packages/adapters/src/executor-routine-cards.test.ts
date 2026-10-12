import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, ConnectorCall } from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { EntryId, EntrySeq, SessionId } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_HOPS,
  BOT_OFFER_PROPOSALS,
  buildSkillMd,
  withProposalKey,
} from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { Prisma } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import { runAutoReviewJudge } from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";
import type { SkillOwnerLock } from "./skill-lock.js";
import { createInMemorySkillLock } from "./skill-lock.js";
import { listUserSkills, skillDirName, userSkillsRoot } from "./skill-store.js";

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
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = store.filter((row) => !matches(row, where));
      const count = store.length - kept.length;
      store.splice(0, store.length, ...kept);
      return { count };
    }),
  };
}

function fixture(
  options: {
    trigger?: string;
    requireToolApproval?: boolean;
    effects?: Effect[];
    groupId?: string;
    /** Routines stored in this space, any bot's; `threadGroupId` is the group of their thread. */
    routines?: Row[];
    /** The routine whose wake started the run. */
    routineId?: string;
    /** Another run of this conversation waits on a card. */
    otherRunWaiting?: boolean;
    /** The model fails with this message once the calls ran. */
    fails?: string;
    skillLearning?: "off" | "shadow" | "on";
    skillLock?: SkillOwnerLock;
    /** The tool calls the skill nudge's turn makes, batch by batch. */
    nudge?: ToolCall[][];
    /** The owner's earlier exchanges, newest first. */
    earlierRuns?: Row[];
    /** What the skill nudge's model call reports it spent. */
    nudgeUsage?: { inputTokens: number; outputTokens: number };
    /** Events the run persisted in an earlier attempt. */
    events?: Row[];
    taskPrompt?: string;
    /** Messages sent into the run as it starts: whether each came from someone but the user. */
    steering?: boolean[];
    /** What the session log holds, any session. */
    entries?: SessionEntry[];
    /** The person's messages the run claimed as steering. */
    claimedSteering?: string[];
  } = {},
) {
  const effects: Effect[] = [...(options.effects ?? [])];
  const log = recordingSessionLog();
  const appended: Row[] = [...(options.events ?? [])];
  const results: unknown[] = [];
  const run: Row = {
    id: "run-1",
    sessionId: "session-1",
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
    Object.entries(where).every(([key, value]) => row[key] === value);
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
  const skillSetting = table([]);
  const botSkill = table([]);
  const usageRecords: Row[] = [];
  const entries = options.entries ?? [];
  log.sessionLog.readRun.mockImplementation(async (runId) =>
    entries.filter((entry) => entry.runId === runId),
  );
  log.sessionLog.readEntry.mockImplementation(async (_sessionId, entryId) =>
    entries.find((entry) => entry.id === entryId),
  );
  const send = vi.fn(async () => undefined);
  const prisma: Row = {
    sessionEntry: log.sessionEntry,
    $transaction: vi.fn(async (ops: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof ops === "function" ? ops(prisma) : Promise.all(ops),
    ),
    $queryRaw: log.queryRaw,
    run: {
      findUnique: vi.fn(async () => run),
      // The waiting run a proposal checks for, or the notification source of a push.
      findFirst: vi.fn(async ({ where, select }: { where: Row; select: Row }) => {
        if (where.status === "waiting_input")
          return options.otherRunWaiting ? { id: "run-other" } : null;
        return select.bot ? { bot: { notifyOnFinish: true }, thread: { groupId: null } } : null;
      }),
      findUniqueOrThrow: vi.fn(async () => run),
      findMany: vi.fn(async () => options.earlierRuns ?? []),
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
        sessionId: "session-main",
        botId: "bot-1",
        nextEventSeq: 2,
      })),
      findFirst: vi.fn(async () => ({ groupId: options.groupId ?? null })),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({ sessionId: "session-main", botId: "bot-1", nextEventSeq: 2 })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Row }) => ({ ...data, threadId: "thread-1" })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: { runId: string; type: { in: string[] } } }) =>
        appended.filter(
          (event) => event.runId === where.runId && where.type.in.includes(event.type as string),
        ),
      ),
    },
    chatGroup: {
      findUnique: vi.fn(async () => ({ name: "Trip", description: "", members: [] })),
    },
    routine: {
      create: routineCreate,
      update: routineUpdate,
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = routines.find((stored) => routineMatches(stored, where));
        return row ? { ...row, thread: { groupId: row.threadGroupId ?? null } } : null;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          routines.find((row) => row.id === where.id) ?? null,
      ),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "task-1",
        prompt: options.taskPrompt ?? "Remind me to stretch",
      })),
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
    usageRecord: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        usageRecords.push(data);
        return data;
      }),
    },
    steeringMessage: {
      findMany: vi.fn(async () =>
        (options.claimedSteering ?? []).map((messageId) => ({ messageId })),
      ),
    },
  };
  const enqueue = vi.fn(async (_job: { name: string; availableAt: Date }) => undefined);
  const cancel = vi.fn(async (_key: string) => undefined);
  const pauseRunForInput = vi.fn(async (_input: { blocks: unknown[] }) => {
    run.status = "waiting_input";
    return true;
  });
  const claimSteering = vi.fn(async () =>
    (options.steering ?? []).map((untrusted, index) => ({
      id: `steer-${index}`,
      messageId: `steer-message-${index}`,
      text: "Save how to order coffee",
      blocks: [{ kind: "text", text: "Save how to order coffee" }],
      untrusted,
    })),
  );
  const finalizeRun = vi.fn(async (input: { outcome: string }) => {
    run.status = input.outcome;
    return { continuationRunId: null };
  });
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let batches: ToolCall[][] = [];
  const nudgeBatches: ToolCall[][] = options.nudge ?? [];
  const nudgeResults: unknown[] = [];
  /** What the run looked like when the skill nudge's turn started. */
  const duringNudge: { runStatus?: unknown; claimedSteering?: number } = {};
  // Mirrors Pi's parallel batch: every call of a turn is announced before any of them runs.
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    const nudge = request.runId.endsWith(":skill-nudge");
    if (nudge) {
      duringNudge.runStatus = run.status;
      duringNudge.claimedSteering = claimSteering.mock.calls.length;
    }
    await request.claimSteering?.([]);
    for (const batch of nudge ? nudgeBatches : batches) {
      const settled = await Promise.all(
        batch.map(async (call, index) => {
          const executionId = `${call.name}-${results.length + index}`;
          const result = await request.executeTool!(call.name, call.args, executionId);
          // Pi's completion: a tool that returns { error } arrives wrapped, never as `error`.
          await request.onToolCompleted?.({
            name: call.name,
            executionId,
            durationMs: 0,
            result: { content: [{ type: "text", text: "" }], details: result },
            paused: isApprovalPausedResult(result),
          });
          return result;
        }),
      );
      (nudge ? nudgeResults : results).push(...settled);
      if (settled.some(isApprovalPausedResult)) return;
    }
    if (options.fails && !nudge) throw new Error(options.fails);
    if (nudge && options.nudgeUsage) {
      yield {
        type: "usage" as const,
        provider: "scripted",
        model: "scripted",
        ...options.nudgeUsage,
      };
    }
    if (nudge) yield { type: "text" as const, text: "I kept the booking method." };
    yield { type: "done" as const, text: nudge ? "I kept the booking method." : "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    sessionLog: log.sessionLog,
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
      append: vi.fn(async (input: Row) => {
        appended.push({ ...input, seq: appended.length + 1 });
      }),
      notify: vi.fn(async () => undefined),
      pauseRunForInput,
      finalizeRun,
      claimSteering,
    },
    jobs: { enqueue, cancel },
    secrets: [],
    dataDir,
    skillLock: options.skillLock ?? createInMemorySkillLock(),
    skillLearning: options.skillLearning,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  const askBlock = () =>
    (pauseRunForInput.mock.calls[0]?.[0] as { blocks: unknown[] } | undefined)?.blocks[0];
  return {
    run,
    log,
    effects,
    externalEffect,
    results,
    routineCreate,
    routineUpdate,
    routines,
    /** When the routine wake-ups were queued for. */
    wakeups: () =>
      enqueue.mock.calls.flatMap(([job]) =>
        job.name === "routine.wakeup" ? [job.availableAt] : [],
      ),
    skills: () =>
      listUserSkills(userSkillsRoot(dataDir, run as { spaceId: string; userId: string })),
    askBlock,
    /** The cards the run posted outside a pause, in order. */
    posted: () =>
      log.drafts.flatMap((draft) =>
        draft.type === "assistant.ask" ? [[(draft.payload as { block: Row }).block]] : [],
      ),
    /** The skill lines the run logged, with the session each went to. */
    learnt: () =>
      log.drafts.flatMap((draft) =>
        draft.type === "skill.learnt" ? [{ sessionId: draft.sessionId, ...draft.payload }] : [],
      ),
    /** The card states the run logged, by the card they settle. */
    applied: () => log.drafts.filter((draft) => draft.type === "effect.applied"),
    /** Makes the effect's card an entry of the thread's session the run can settle. */
    showCard(cardId: string, effectId: string) {
      log.sessionEntry.findFirst.mockImplementation((async ({ where }: { where: Row }) =>
        (where.payload as { equals?: unknown } | undefined)?.equals === effectId
          ? { id: cardId }
          : null) as never);
      log.sessionEntry.findUnique.mockImplementation((async ({ where }: { where: Row }) =>
        where.id === cardId ? { sessionId: "session-main" } : null) as never);
    },
    send,
    instructions: () =>
      (runtimeRun.mock.calls[0]?.[0] as AgentRunRequest | undefined)?.instructions,
    /** Every turn the runtime was asked for: the exchange, then the skill nudge's, if any. */
    requests: () => runtimeRun.mock.calls.map(([request]) => request as AgentRunRequest),
    nudgeResults,
    duringNudge,
    usageRecords,
    /** The payloads of the events of one type the run persisted, in order. */
    eventsOf: (type: string) =>
      appended.filter((event) => event.type === type).map((event) => event.payload),
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

const at = async <T>(now: string, test: () => Promise<T>) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  try {
    return await test();
  } finally {
    vi.useRealTimers();
  }
};

describe("a routine the bot proposes on its own", () => {
  const offers = {
    name: "Weekly offers",
    prompt: "Summarize the new offers. Message me only if there is one.",
    cron: "0 9 * * 1",
    timezone: "Europe/Paris",
    proposed: true,
    question: "Je m'en occupe chaque lundi matin ?",
  };
  const { cron: _cron, ...oneShot } = offers;
  const propose = (args: Record<string, unknown> = {}, base: Record<string, unknown> = offers) => ({
    name: "schedule_create",
    args: { ...base, ...args },
  });
  const proposalCard = {
    kind: "ask",
    proposal: "routine",
    text: "Je m'en occupe chaque lundi matin ?",
    status: "pending",
    actions: [
      { id: "allow", label: "Create routine", outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
    routine: {
      name: "Weekly offers",
      schedule: "Mondays at 09:00 Europe/Paris",
      prompt: "Summarize the new offers. Message me only if there is one.",
      notify: false,
    },
  };
  const proposalEffect = (overrides: Partial<Effect>): Effect => ({
    id: "effect-earlier",
    runId: "run-0",
    kind: "routine_proposal",
    idempotencyKey: "earlier-key",
    status: "denied",
    request: offers,
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    answeredAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    ...overrides,
  });

  it("shows a Create routine card with the resolved schedule, creates nothing and sends no push", async () => {
    const f = fixture();
    await f.play([[propose()]]);
    expect(f.askBlock()).toEqual({
      ...proposalCard,
      approvalEffectId: "effect-1",
      detail: [
        "name: Weekly offers",
        "schedule: Mondays at 09:00 Europe/Paris",
        "notify: no",
        "prompt:",
        "  Summarize the new offers. Message me only if there is one.",
      ].join("\n"),
    });
    expect(f.effects.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "routine_proposal", status: "intended" },
    ]);
    expect(f.routineCreate).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("still pushes the card a run nobody started must show", async () => {
    const f = fixture({ trigger: "webhook" });
    await f.play([[routine]]);
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Assistant needs approval" }),
      expect.anything(),
    );
  });

  it.each([
    ["proposed that is not a boolean", { proposed: "true" }, "proposed must be true or false."],
    [
      "a time already past",
      { runAt: "2020-01-01T09:00:00Z" },
      "One-shot schedules must run in the future.",
      oneShot,
    ],
    [
      "a zone that does not exist",
      { timezone: "Mars/Olympus" },
      "timezone must be an IANA time zone, such as Europe/Paris.",
    ],
    [
      "a schedule more often than hourly",
      { every: 30, unit: "minutes" },
      "A routine you propose must run at most once an hour.",
      oneShot,
    ],
    [
      "a delay of millions of years",
      { delayMinutes: 1e12 },
      "One-shot schedules must run within 5 years.",
      oneShot,
    ],
    [
      "a question on two lines",
      { question: "Chaque lundi ?\nOu mardi ?" },
      "question must be a single line of visible text, without invisible or control characters.",
    ],
    [
      "a name shaped like a link",
      { name: "[Offers](https://example.test)" },
      "name cannot contain [, ], <, > or a web address (://, www.).",
    ],
  ] as const)("refuses %s before any card", async (_label, patch, error, base = offers) => {
    const f = fixture();
    await f.play([[propose(patch, base)]]);
    expect(f.results).toEqual([{ error }]);
    expect(f.askBlock()).toBeUndefined();
    expect(f.effects).toEqual([]);
  });

  it("turns a delay into the time it points to when the card shows, not when the run began", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    try {
      const f = fixture();
      f.run.createdAt = new Date("2026-10-06T08:00:00Z");
      await f.play([[propose({ delayMinutes: 90 }, oneShot)]]);
      expect(f.effects[0]?.request).toEqual({
        ...oneShot,
        runAt: "2026-10-06T11:30:00.000Z",
        proposalKey: "weekly offers",
      });
      expect(f.askBlock()).toMatchObject({
        routine: { schedule: "Once on Oct 6, 2026 at 13:30 Europe/Paris" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a time that passed since the card", { runAt: "2020-01-01T09:00:00Z" }, oneShot],
    ["a delay counted again", { delayMinutes: 10 }, oneShot],
  ])(
    "answers a resumed call after Not now with the refusal, whatever %s",
    async (_l, patch, base) => {
      const args = propose(patch, base).args;
      const f = fixture({
        effects: [
          proposalEffect({
            runId: "run-1",
            idempotencyKey: approvalEffectKey("run-1", "routine_proposal", args),
            request: { ...args, runAt: "2026-01-01T09:00:00.000Z" },
          }),
        ],
      });
      await f.play([[propose(patch, base)]]);
      expect(f.results).toEqual([
        {
          ok: false,
          declined: true,
          note: "The user declined this routine. Do not propose it again within a day.",
        },
      ]);
      expect(f.askBlock()).toBeUndefined();
    },
  );

  it("checks the question only on a card", async () => {
    const direct = fixture();
    await direct.play([[{ ...routine, args: { ...routine.args, question: "Two\nlines" } }]]);
    expect(direct.routineCreate).toHaveBeenCalled();
    expect(direct.askBlock()).toBeUndefined();
  });

  it.each([
    ["in a group", { groupId: "group-1" }],
    ["in a run nobody started", { trigger: "webhook" }],
  ])("is refused %s", async (_label, options) => {
    const f = fixture(options);
    await f.play([[propose()]]);
    expect(f.results).toEqual([
      {
        error:
          "Propose a routine only in your direct conversation with the user, while they are in it.",
      },
    ]);
    expect(f.askBlock()).toBeUndefined();
  });

  it("waits while another card waits in the conversation", async () => {
    const f = fixture({ otherRunWaiting: true });
    await f.play([[propose()]]);
    expect(f.results).toEqual([
      {
        error:
          "Another card is already waiting for the user's answer in this conversation. Do not propose anything until they answer.",
      },
    ]);
    expect(f.askBlock()).toBeUndefined();
  });

  it("keeps one card when one batch proposes twice", async () => {
    const f = fixture();
    await f.play([[propose(), propose({ name: "Daily offers", cron: "0 9 * * *" })]]);
    expect(f.askBlock()).toMatchObject({ approvalEffectId: "effect-1" });
    expect(f.effects.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "routine_proposal", status: "intended" },
      { kind: "routine_proposal", status: "completed" },
    ]);
    expect(f.effects[1]?.result).toEqual({
      error:
        "Another card is already waiting for the user's answer in this conversation. Do not propose anything until they answer.",
    });
  });

  it("keeps a routine the user said Not now to away for a day from when they said it", async () => {
    const saidHoursAgo = async (hours: number) => {
      const said = new Date(Date.now() - hours * 60 * 60 * 1000);
      const f = fixture({
        effects: [
          proposalEffect({
            request: withProposalKey({ ...offers, name: "weekly OFFERS" }, "weekly OFFERS"),
            createdAt: said,
            answeredAt: said,
          }),
        ],
      });
      await f.play([[propose()]]);
      return f;
    };
    const recent = await saidHoursAgo(23);
    expect(recent.results).toEqual([
      {
        error:
          "The user said Not now to this routine in the last day. Do not propose it again today unless they ask.",
      },
    ]);
    expect(recent.askBlock()).toBeUndefined();
    const past = await saidHoursAgo(25);
    expect(past.askBlock()).toMatchObject({
      proposal: "routine",
      routine: { name: "Weekly offers" },
    });
  });

  it("proposes another routine the same day, and corrects a card the user answered by typing", async () => {
    const recent = { createdAt: new Date(Date.now() - 60 * 60 * 1000), answeredAt: new Date() };
    const unrelated = fixture({
      effects: [proposalEffect({ ...recent, status: "completed", request: { name: "Other" } })],
    });
    await unrelated.play([[propose()]]);
    expect(unrelated.askBlock()).toMatchObject({ routine: { name: "Weekly offers" } });

    const corrected = fixture({
      effects: [proposalEffect({ ...recent, runId: "run-1", result: { outcome: "dismissed" } })],
    });
    await corrected.play([[propose({ cron: "0 9 * * 2" })]]);
    expect(corrected.askBlock()).toMatchObject({
      routine: { schedule: "Tuesdays at 09:00 Europe/Paris" },
    });
  });

  it("corrects as many times as the user asks, and stops at a Not now", async () => {
    const typed = (id: string, hoursAgo: number, overrides: Partial<Effect> = {}) =>
      proposalEffect({
        id,
        idempotencyKey: id,
        runId: "run-1",
        result: { outcome: "dismissed" },
        createdAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
        answeredAt: new Date(),
        ...overrides,
      });
    const chain = [typed("e1", 4), typed("e2", 3), typed("e3", 2), typed("e4", 1)];
    const fifth = fixture({ effects: chain });
    await fifth.play([[propose({ cron: "0 9 * * 2" })]]);
    expect(fifth.askBlock()).toMatchObject({
      routine: { schedule: "Tuesdays at 09:00 Europe/Paris" },
    });

    const stopped = fixture({
      effects: [...chain, typed("e5", 0.5, { result: undefined })],
    });
    await stopped.play([[propose({ cron: "0 9 * * 2" })]]);
    expect(stopped.results).toEqual([
      {
        ok: false,
        declined: true,
        note: "The user declined this routine. Do not propose it again within a day.",
      },
    ]);
  });

  const answered = (result?: unknown) => {
    const args = propose().args;
    return proposalEffect({
      runId: "run-1",
      idempotencyKey: approvalEffectKey("run-1", "routine_proposal", args),
      request: args,
      result,
    });
  };

  it("tells the resumed model the card was answered by Not now", async () => {
    const f = fixture({ effects: [answered()] });
    await f.play([[propose()]]);
    expect(f.results).toEqual([
      {
        ok: false,
        declined: true,
        note: "The user declined this routine. Do not propose it again within a day.",
      },
    ]);
    expect(f.askBlock()).toBeUndefined();
  });

  it("tells the resumed model to create what a typed yes agreed to, and creates it with its card", async () => {
    const f = fixture({ effects: [answered({ outcome: "dismissed" })] });
    const { proposed: _proposed, ...agreed } = offers;
    await f.play([[propose()], [{ name: "schedule_create", args: agreed }]]);
    expect(f.results).toEqual([
      {
        ok: false,
        dismissed: true,
        note: "The user typed a reply instead of tapping the card. If they agreed to it, create the routine now: call schedule_create with the same arguments, without proposed. If they asked for a change, propose the corrected version now, however many times they ask. If the reply was about something else, do not propose again.",
      },
      expect.objectContaining({
        ok: true,
        routineId: "routine-new",
        schedule: "Mondays at 09:00 Europe/Paris",
      }),
    ]);
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.askBlock()).toBeUndefined();
    expect(f.posted()).toEqual([
      [
        expect.objectContaining({
          status: "answered",
          text: "Mondays at 09:00 Europe/Paris",
          created: { kind: "routine", id: "routine-new", label: "Weekly offers" },
          confirms: "created",
        }),
      ],
    ]);
  });

  describe("once the user tapped Create routine", () => {
    const approved = (request: Record<string, unknown>): Effect => ({
      id: "effect-approved",
      runId: "run-1",
      kind: "routine_proposal",
      idempotencyKey: approvalEffectKey("run-1", "routine_proposal", request),
      status: "approved",
      request,
      createdAt: new Date(),
      answeredAt: new Date(),
    });
    const logged = (f: ReturnType<typeof fixture>) => {
      f.showCard("m2", "effect-approved");
      return f.applied;
    };

    it("creates exactly the routine shown, past every guard, and links the card to it", async () => {
      const f = fixture({
        effects: [proposalEffect({}), approved(offers)],
        otherRunWaiting: true,
      });
      const applied = logged(f);
      await f.play([[propose({ name: "Something else", prompt: "Rewritten" })]]);
      expect(f.routineCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Weekly offers",
          prompt: "Summarize the new offers. Message me only if there is one.",
          crons: ["0 9 * * 1"],
          timezone: "Europe/Paris",
        }),
      });
      expect(f.posted()).toEqual([]);
      expect(applied()).toEqual([
        {
          type: "effect.applied",
          sessionId: "session-main",
          feedBotId: "bot-1",
          payload: { target: "m2", routineId: "routine-new", change: "created" },
        },
      ]);
    });

    it("creates the one-shot routine at the time its card showed", async () => {
      const asked = propose({ delayMinutes: 90 }, oneShot).args;
      const runAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const f = fixture({
        effects: [
          {
            ...approved({ ...oneShot, runAt, proposalKey: "weekly offers" }),
            idempotencyKey: approvalEffectKey("run-1", "routine_proposal", asked),
          },
        ],
      });
      const applied = logged(f);
      await f.play([[propose({ delayMinutes: 90 }, oneShot)]]);
      expect(f.routineCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ nextRunAt: new Date(runAt) }),
      });
      expect(applied()).toEqual([
        expect.objectContaining({
          payload: { target: "m2", routineId: "routine-new", change: "created" },
        }),
      ]);
    });

    it("marks the card Couldn't create when the run ends before creating it", async () => {
      const f = fixture({ effects: [approved(offers)] });
      const applied = logged(f);
      await f.play([], "worker-1", "failed");
      expect(f.routineCreate).not.toHaveBeenCalled();
      expect(applied()).toEqual([
        {
          type: "effect.applied",
          sessionId: "session-main",
          feedBotId: "bot-1",
          payload: { target: "m2", failed: true },
        },
      ]);
      expect(f.effects[0]).toMatchObject({
        status: "completed",
        result: { error: "The run ended before this routine was created." },
      });
    });

    it("lets the bot propose again the same day once a card could not create its routine", async () => {
      const f = fixture({
        effects: [
          proposalEffect({
            status: "completed",
            createdAt: new Date(Date.now() - 60 * 60 * 1000),
            answeredAt: new Date(),
            result: { error: "One-shot schedules must run in the future." },
          }),
        ],
      });
      await f.play([[propose({ name: "Monday offers" })]]);
      expect(f.askBlock()).toMatchObject({ routine: { name: "Monday offers" } });
    });

    it("marks the card Couldn't create when the time passed before the tap", async () => {
      const past = { ...oneShot, runAt: "2020-01-01T09:00:00Z" };
      const f = fixture({ effects: [approved(past)] });
      const applied = logged(f);
      await f.play([[propose({}, past)]]);
      expect(f.routineCreate).not.toHaveBeenCalled();
      expect(f.results).toEqual([{ error: "One-shot schedules must run in the future." }]);
      expect(applied()).toEqual([
        expect.objectContaining({ payload: { target: "m2", failed: true } }),
      ]);
    });
  });
});

describe("what the bot is told about proposing", () => {
  it.each([
    ["in a group", { groupId: "group-1" }],
    ["in a run nobody started", { trigger: "webhook" }],
  ])("says nothing of proposals %s", async (_label, options) => {
    const f = fixture(options);
    await f.play([]);
    expect(f.instructions()).not.toContain(BOT_OFFER_PROPOSALS);
  });

  it("creates a routine asked for plainly in a clean conversation, with no card, while proposals are offered", async () => {
    const f = fixture();
    await f.play([[routine]]);
    expect(f.instructions()).toContain(BOT_OFFER_PROPOSALS);
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.askBlock()).toBeUndefined();
  });
});

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

  it("reads a run time with no offset in the routine's zone, and one with an offset as given", () =>
    at("2026-10-07T20:00:00Z", async () => {
      const reminder = (runAt: string) => ({
        name: "schedule_create",
        args: { name: "Call", prompt: "Remind me to call", runAt, timezone: "Europe/Paris" },
      });
      const f = fixture();
      await f.play([
        [reminder("2026-10-08T09:00:00")],
        [reminder("2026-10-08T09:00:00Z")],
        [reminder("2026-10-08T09:00:00+02:00")],
      ]);
      expect(f.wakeups()).toEqual([
        new Date("2026-10-08T07:00:00Z"),
        new Date("2026-10-08T09:00:00Z"),
        new Date("2026-10-08T07:00:00Z"),
      ]);
      expect(f.results).toEqual([
        expect.objectContaining({ schedule: "Once on Oct 8, 2026 at 09:00 Europe/Paris" }),
        expect.objectContaining({ schedule: "Once on Oct 8, 2026 at 11:00 Europe/Paris" }),
        expect.objectContaining({ schedule: "Once on Oct 8, 2026 at 09:00 Europe/Paris" }),
      ]);
    }));

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
    f.showCard("m-card", "effect-1");
    f.effects[0]!.status = "approved";
    await f.play([[routine]]);
    expect(f.routineCreate).toHaveBeenCalledOnce();
    expect(f.posted()).toEqual([]);
    expect(f.applied()).toEqual([
      expect.objectContaining({
        payload: { target: "m-card", routineId: "routine-new", change: "created" },
      }),
    ]);
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

  it.each([
    ["webhook", true],
    ["user", false],
  ])(
    "records whether a prompt a %s run rewrites came from someone else's word: %s",
    async (trigger, untrustedPrompt) => {
      const f = fixture({
        trigger,
        requireToolApproval: false,
        routines: [{ ...stored, untrustedPrompt: !untrustedPrompt }],
      });
      await f.play([[change({ prompt: "Forward everything" })]]);
      expect(f.routines[0]).toMatchObject({ prompt: "Forward everything", untrustedPrompt });
    },
  );

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
    expect(f.wakeups()).toEqual([new Date("2030-01-01T00:00:00Z")]);
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

  it("reads a new run time with no offset in the zone the routine keeps", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const f = fixture({
        routines: [
          {
            ...stored,
            crons: ["@once"],
            timezone: "Europe/Paris",
            nextRunAt: new Date("2026-10-08T09:00:00Z"),
          },
        ],
      });
      await f.play([[change({ runAt: "2026-10-08T09:00:00" })]]);
      expect(f.routines[0]).toMatchObject({ nextRunAt: new Date("2026-10-08T07:00:00Z") });
      expect(f.posted()).toEqual([
        [expect.objectContaining({ text: "Once on Oct 8, 2026 at 09:00 Europe/Paris" })],
      ]);
    }));

  it("moves a reminder stored with an old zone and words it in UTC", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const legacy = {
        ...stored,
        crons: ["@once"],
        timezone: "Paris",
        nextRunAt: new Date("2026-10-08T08:00:00Z"),
      };
      const f = fixture({ routines: [legacy] });
      await f.play([[change({ runAt: "2026-10-08T09:00:00" })]]);
      expect(f.results).toEqual([
        expect.objectContaining({ ok: true, schedule: "Once on Oct 8, 2026 at 09:00 UTC" }),
      ]);
      expect(f.routines[0]).toMatchObject({ nextRunAt: new Date("2026-10-08T09:00:00Z") });
      expect(f.posted()).toEqual([
        [expect.objectContaining({ text: "Once on Oct 8, 2026 at 09:00 UTC" })],
      ]);
    }));

  it("refuses to move a reminder more than 5 years ahead", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const reminder = { ...stored, crons: ["@once"], nextRunAt: new Date("2026-10-08T08:00:00Z") };
      const f = fixture({ routines: [reminder] });
      await f.play([[change({ runAt: "2031-10-08T08:00:00Z" })]]);
      expect(f.results).toEqual([{ error: "One-shot schedules must run within 5 years." }]);
      expect(f.routines[0]).toMatchObject({ nextRunAt: new Date("2026-10-08T08:00:00Z") });
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
    f.showCard("m-card", "effect-1");
    f.effects[0]!.status = "approved";
    await f.play([[change({ notify: true })]]);
    expect(f.posted()).toEqual([]);
    expect(f.applied()).toEqual([
      expect.objectContaining({
        payload: { target: "m-card", routineId: "routine-1", change: "updated" },
      }),
    ]);
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

  it("moves an armed reminder to the same time in a new zone, and refuses one that has passed there", () =>
    at("2026-10-07T10:00:00Z", async () => {
      const reminder = {
        ...stored,
        name: "Call mum",
        crons: ["@once"],
        timezone: "Europe/Paris",
        nextRunAt: new Date("2026-10-08T06:00:00Z"),
      };
      const f = fixture({ routines: [reminder] });
      await f.play([[change({ timezone: "America/New_York" })]]);
      expect(f.routines[0]).toMatchObject({
        timezone: "America/New_York",
        nextRunAt: new Date("2026-10-08T12:00:00Z"),
      });
      expect(f.wakeups()).toEqual([new Date("2026-10-08T12:00:00Z")]);
      expect(f.posted()).toEqual([
        [expect.objectContaining({ text: "Once on Oct 8, 2026 at 08:00 America/New_York" })],
      ]);

      const soon = { ...reminder, nextRunAt: new Date("2026-10-07T10:30:00Z") };
      const passed = fixture({ routines: [soon] });
      await passed.play([[change({ timezone: "Asia/Tokyo" })]]);
      expect(passed.results).toEqual([{ error: "Run time must be in the future." }]);
      expect(passed.routineUpdate).not.toHaveBeenCalled();
    }));

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

  const changed = expect.objectContaining({ ok: true });
  it.each([
    [
      "a group's routine from the direct conversation",
      undefined,
      "thread-group",
      "group-1",
      { error: "This routine belongs to a group: change it from that group." },
    ],
    ["a direct routine from the direct conversation", undefined, "thread-1", null, changed],
    [
      "a direct routine from a group",
      "group-1",
      "thread-direct",
      null,
      { error: "Routine not found." },
    ],
    ["the group's own routine from that group", "group-1", "thread-1", "group-1", changed],
  ])(
    "changes %s only when it belongs there",
    async (_label, groupId, threadId, threadGroupId, result) => {
      const f = fixture({ groupId, routines: [{ ...stored, threadId, threadGroupId }] });
      await f.play([[change({ notify: true })]]);
      expect(f.results).toEqual([result]);
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

  it("refuses a proposed change", async () => {
    const f = fixture({ routines: [stored] });
    await f.play([[change({ proposed: true, cron: "0 9 * * *" })]]);
    expect(f.results).toEqual([{ error: "Proposing a change to a routine is not available yet." }]);
    expect(f.askBlock()).toBeUndefined();
    expect(f.routineUpdate).not.toHaveBeenCalled();
  });
});

describe("a skill the bot saves on its own", () => {
  const save = {
    name: "skill_create",
    args: { name: "Coffee", description: "Order coffee", body: "Pay." },
  };
  const line = {
    sessionId: "session-1",
    skillId: "user:coffee",
    name: "Coffee",
    change: "learned",
  };
  /** The run said something to the user, which its line goes under. */
  const replied = (f: ReturnType<typeof fixture>) =>
    f.log.sessionEntry.findFirst.mockImplementation((async ({ where }: { where: Row }) =>
      where.type === "assistant.text" ? { id: "reply" } : null) as never);

  it("leaves the line the server writes under the run's reply once the run ends", async () => {
    const f = fixture({ skillLearning: "off" });
    replied(f);
    await f.play([[save]]);
    expect(f.results).toEqual([expect.objectContaining({ ok: true, name: "Coffee" })]);
    expect(f.learnt()).toEqual([line]);
  });

  it("leaves the line under the reply of a run that failed after saving", async () => {
    const f = fixture({ skillLearning: "off", fails: "The model is unreachable." });
    replied(f);
    await f.play([[save]], "worker-1", "failed");
    expect(f.learnt()).toEqual([line]);
  });

  it("writes nothing visible for a run that left no message while learning is off", async () => {
    const f = fixture({ skillLearning: "off" });
    await f.play([[save]]);
    expect(f.learnt()).toEqual([]);
    expect(f.run.skillLinesAt).toBeInstanceOf(Date);
  });

  it.each(["shadow", "on"] as const)(
    "logs the line alone for a run that left no message once learning is %s",
    async (skillLearning) => {
      const f = fixture({ skillLearning });
      await f.play([[save]]);
      expect(f.learnt()).toEqual([line]);
    },
  );

  it("is announced by the bot while learning is off", async () => {
    const today = fixture({ skillLearning: "off" });
    await today.play([[save]]);
    expect(today.instructions()).toContain(
      "After creating or updating one, mention /Name so the user can open it.",
    );
    expect(today.results).toEqual([
      expect.objectContaining({ hint: expect.stringContaining("Mention /Coffee") }),
    ]);

    const learning = fixture({ skillLearning: "shadow" });
    await learning.play([[{ ...save, args: { ...save.args, name: "Tea" } }]]);
    expect(learning.instructions()).not.toContain("mention /Name");
    expect(learning.instructions()).toContain(
      "Do not announce it: the app shows a line under your message.",
    );
    expect(learning.results).toEqual([
      expect.objectContaining({
        hint: "Created skill, available to this agent until the user shares it. The app shows the user a line for it: do not announce it.",
      }),
    ]);
  });

  it("refuses it once a webhook steers into the user's run, and saves it when they steer", async () => {
    const steered = fixture({ requireToolApproval: false, steering: [false, true] });
    await steered.play([[save]]);
    expect(steered.results).toEqual([
      {
        error:
          "Skills can't be saved in this run: only a conversation the user started, one of their routines or a sub-bot they created can save one.",
      },
    ]);
    expect(steered.askBlock()).toBeUndefined();
    expect(await steered.skills()).toEqual([]);

    const own = fixture({ requireToolApproval: false, steering: [false] });
    await own.play([[save]]);
    expect(own.results).toEqual([expect.objectContaining({ ok: true, name: "Coffee" })]);
    expect((await own.skills()).map((skill) => skill.name)).toEqual(["Coffee"]);
  });

  it("refuses it in a webhook run without asking the owner", async () => {
    const f = fixture({ trigger: "webhook" });
    await f.play([[save]]);
    expect(f.results).toEqual([
      {
        error:
          "Skills can't be saved in this run: only a conversation the user started, one of their routines or a sub-bot they created can save one.",
      },
    ]);
    expect(f.askBlock()).toBeUndefined();
    expect(await f.skills()).toEqual([]);
  });

  const daily = (untrustedPrompt: boolean) => ({
    id: "routine-daily",
    name: "Daily",
    prompt: "Order coffee",
    notify: false,
    crons: ["0 9 * * *"],
    untrustedPrompt,
  });

  it("saves it in a run of a routine the user set up, but deletes nothing there", async () => {
    const f = fixture({ trigger: "routine", routineId: "routine-daily", routines: [daily(false)] });
    await f.play([[save], [{ name: "skill_delete", args: { name: "Coffee" } }]]);
    expect(f.results).toEqual([
      expect.objectContaining({ ok: true, name: "Coffee" }),
      { error: "Delete a skill only when the user asks you to in this conversation." },
    ]);
    expect((await f.skills()).map((skill) => skill.name)).toEqual(["Coffee"]);
  });

  it("refuses it in a run of a routine a bot set up on someone else's word", async () => {
    const f = fixture({ trigger: "routine", routineId: "routine-daily", routines: [daily(true)] });
    await f.play([[save]]);
    expect(f.results).toEqual([
      {
        error:
          "Skills can't be saved in this run: only a conversation the user started, one of their routines or a sub-bot they created can save one.",
      },
    ]);
    expect(await f.skills()).toEqual([]);
  });

  it.each([
    ["user", false],
    ["webhook", true],
    ["messaging", true],
  ])(
    "records whether a routine a %s run sets up came from someone else's word: %s",
    async (trigger, untrustedPrompt) => {
      const f = fixture({ trigger, requireToolApproval: false });
      await f.play([[routine]]);
      expect(f.routineCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ untrustedPrompt }),
      });
    },
  );

  it("records a routine set up once a webhook steered into the user's run as someone else's word", async () => {
    const f = fixture({ requireToolApproval: false, steering: [true] });
    await f.play([[routine]]);
    expect(f.routineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ untrustedPrompt: true }),
    });
  });
});

describe("the skill nudge at the end of an exchange", () => {
  const longTask = Array.from({ length: 15 }, () => ({
    name: "skill_search",
    args: { query: "table" },
  }));
  // The exchange answers the user, which only message_user does.
  const reply = { name: "message_user", args: { message: "Done" } };
  const searches = [...longTask, reply];
  const keep = {
    name: "skill_create",
    args: { name: "Book a table", description: "Book a restaurant table", body: "1. Call." },
  };
  const writeCoffee = async () => {
    const folder = path.join(
      userSkillsRoot(dataDir, { spaceId: "space-1", userId: "user-1" }),
      skillDirName("Coffee"),
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "SKILL.md"),
      buildSkillMd({ name: "Coffee", description: "Order coffee", body: "1. Pay." }),
    );
  };
  const line = (name: string) => ({
    sessionId: "session-1",
    skillId: `user:${name.toLowerCase()}`,
    name,
    change: "learned",
  });

  it("never runs, nor records anything, while learning is off", async () => {
    const f = fixture({ skillLearning: "off", nudge: [[keep]] });
    await f.play([searches, [{ name: "skill_read", args: { name: "Skill-authoring" } }]]);
    expect(f.requests()).toHaveLength(1);
    expect(f.eventsOf("agent.skill.nudge")).toEqual([]);
    expect(f.eventsOf("agent.skill.used")).toEqual([]);
    expect(await f.skills()).toEqual([]);
  });

  it("in shadow mode records that it would have run, without a model call", async () => {
    const f = fixture({ skillLearning: "shadow", nudge: [[keep]] });
    await f.play([searches]);
    expect(f.requests()).toHaveLength(1);
    expect(f.eventsOf("agent.skill.nudge")).toEqual([
      { phase: "decided", mode: "shadow", signal: "tools", toolCount: 15 },
    ]);
    expect(await f.skills()).toEqual([]);
  });

  it("runs one private turn with skill tools only, after the run let go, and its skill gets the line", async () => {
    const f = fixture({
      skillLearning: "on",
      nudge: [[keep], [{ name: "message_user", args: { text: "Saved it!" } }]],
    });
    await f.play([searches]);

    const [, nudge] = f.requests();
    expect(f.requests()).toHaveLength(2);
    expect(nudge).toMatchObject({ runId: "run-1:skill-nudge", allowSilentEmpty: true });
    expect(nudge!.claimSteering).toBeUndefined();
    expect(nudge!.prompt).toContain("This task took many steps.");
    expect(nudge!.tools.map((tool) => tool.name)).toEqual([
      "skill_read",
      "skill_search",
      "skill_create",
      "skill_update",
    ]);
    expect(f.duringNudge).toEqual({ runStatus: "completed", claimedSteering: 1 });
    expect(f.nudgeResults).toEqual([
      expect.objectContaining({ ok: true, name: "Book a table" }),
      { error: "Only skill_read, skill_search, skill_create and skill_update work here." },
    ]);
    expect(f.learnt()).toEqual([line("Book a table")]);
    expect(JSON.stringify(f.log.drafts)).not.toContain("I kept the booking method.");
    expect(f.eventsOf("agent.skill.nudge")).toEqual([
      { phase: "decided", mode: "on", signal: "tools", toolCount: 15 },
      { phase: "ended" },
    ]);
    expect(
      f.eventsOf("agent.tool.completed").filter((payload) => (payload as Row).nudge === true),
    ).toEqual([
      expect.objectContaining({ name: "skill_create", outcome: "succeeded" }),
      expect.objectContaining({ name: "message_user", outcome: "error" }),
    ]);
  });

  it("does not count the nudge's own skill reads as the exchange following a skill", async () => {
    await writeCoffee();
    const f = fixture({
      skillLearning: "on",
      nudge: [[{ name: "skill_read", args: { name: "Coffee" } }]],
    });
    await f.play([searches]);
    expect(f.requests()).toHaveLength(2);
    expect(f.nudgeResults).toHaveLength(1);
    expect(f.eventsOf("agent.skill.used")).toEqual([]);
  });

  it("names the skill the bot followed when a later step failed", async () => {
    await writeCoffee();
    const f = fixture({ skillLearning: "on" });
    await f.play([
      [{ name: "skill_read", args: { name: "Coffee" } }],
      [{ name: "skill_read", args: { name: "Espresso" } }],
      [reply],
    ]);
    expect(f.eventsOf("agent.skill.used")).toEqual([{ name: "Coffee", via: "skill_read" }]);
    expect(f.requests()[1]!.prompt).toContain(
      'You followed the skill "Coffee" and a later step failed.',
    );
  });

  it("counts a skill as followed when forced with /Name or when its folder is read, and skips a failed run", async () => {
    await writeCoffee();
    const f = fixture({ skillLearning: "on", taskPrompt: "/Coffee\nA flat white" });
    // The fixture has no computer, so the shell call itself fails the run.
    await f.play(
      [[{ name: "shell", args: { command: "python /skills/user/coffee/scripts/pay.py" } }]],
      "worker-1",
      "failed",
    );
    expect(f.eventsOf("agent.skill.used")).toEqual([
      { name: "Coffee", via: "forced" },
      { name: "Coffee", via: "file" },
    ]);
    expect(f.requests()).toHaveLength(1);
    expect(f.eventsOf("agent.skill.nudge")).toEqual([]);
  });

  it("does not run again for a run whose earlier attempt was already nudged", async () => {
    const f = fixture({
      skillLearning: "on",
      nudge: [[keep]],
      events: [{ runId: "run-1", type: "agent.skill.nudge", payload: { phase: "decided" } }],
    });
    await f.play([searches]);
    expect(f.requests()).toHaveLength(1);
    expect(await f.skills()).toEqual([]);
  });

  it("skips the turn, and still ends the run, when past skill writes cannot be read", async () => {
    await writeCoffee();
    const f = fixture({ skillLearning: "on", earlierRuns: [{ id: "run-0" }], nudge: [[keep]] });
    const read = f.externalEffect.findMany.getMockImplementation()!;
    f.externalEffect.findMany.mockImplementation(async (args) => {
      const kinds = (args?.where?.kind as { in?: string[] } | undefined)?.in;
      if (kinds?.includes("skill_create")) throw new Error("effects unavailable");
      return read(args);
    });
    await f.play([
      [{ name: "skill_read", args: { name: "Coffee" } }],
      [{ name: "skill_read", args: { name: "Espresso" } }],
      [reply],
    ]);
    expect(f.eventsOf("agent.skill.used")).toEqual([{ name: "Coffee", via: "skill_read" }]);
    expect(f.requests()).toHaveLength(1);
    expect(f.eventsOf("agent.skill.nudge")).toEqual([]);
    expect(await f.skills()).toHaveLength(1);
  });

  it("in shadow mode records why it passed over a turn the user started", async () => {
    const f = fixture({ skillLearning: "shadow" });
    await f.play([[...searches.slice(0, 3), reply]]);
    expect(f.eventsOf("agent.skill.nudge")).toEqual([
      { phase: "skipped", mode: "shadow", reason: "no_signal" },
    ]);
  });

  it("shows the turn what the user said while the exchange ran, and nothing said after", async () => {
    const text = (value: string) => [{ kind: "text" as const, text: value }];
    const said = (id: string, seq: number, value: string): SessionEntry => ({
      id: EntryId.parse(id),
      sessionId: SessionId.parse("session-main"),
      seq: EntrySeq.parse(seq),
      parentId: null,
      ts: `2026-10-11T09:00:0${seq}.000Z`,
      type: "user.message",
      payload: { blocks: text(value), source: "app" },
    });
    const f = fixture({
      skillLearning: "on",
      entries: [
        said("steer", 3, "No, always the pro account."),
        {
          id: EntryId.parse("reply"),
          sessionId: SessionId.parse("session-main"),
          seq: EntrySeq.parse(4),
          parentId: EntryId.parse("steer"),
          ts: "2026-10-11T09:00:04.000Z",
          botId: "bot-1",
          runId: "run-1",
          type: "assistant.text",
          payload: { blocks: text("Booked with the pro account.") },
        },
        said("next", 5, "Thanks!"),
      ],
      claimedSteering: ["steer"],
    });
    await f.play([searches]);
    expect(f.requests()[1]!.history.slice(-2)).toEqual([
      { id: "steer", role: "user", content: "No, always the pro account." },
      { id: "reply", role: "assistant", content: "Booked with the pro account." },
    ]);
  });

  it("counts the turn's model spend, and records its skill writes, under the exchange's run", async () => {
    const f = fixture({
      skillLearning: "on",
      nudge: [[keep]],
      nudgeUsage: { inputTokens: 1200, outputTokens: 40 },
    });
    await f.play([searches]);
    expect(f.usageRecords).toEqual([
      {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "user-1",
        runId: "run-1",
        provider: "scripted",
        model: "scripted",
        inputTokens: 1200,
        outputTokens: 40,
      },
    ]);
    expect(f.effects.filter((effect) => effect.kind === "skill_create")).toEqual([
      expect.objectContaining({
        runId: "run-1",
        kind: "skill_create",
        idempotencyKey: expect.stringMatching(/^run-1:skill-nudge:/),
        status: "completed",
      }),
    ]);
  });

  it("does not run once a webhook steered into the exchange", async () => {
    const f = fixture({ skillLearning: "on", steering: [true], nudge: [[keep]] });
    await f.play([[keep], searches]);
    expect(f.results[0]).toEqual({
      error:
        "Skills can't be saved in this run: only a conversation the user started, one of their routines or a sub-bot they created can save one.",
    });
    expect(f.requests()).toHaveLength(1);
    expect(f.nudgeResults).toEqual([]);
    expect(f.learnt()).toEqual([]);
    expect(await f.skills()).toEqual([]);
  });

  it("does not run for a routine, even a long one", async () => {
    const f = fixture({ skillLearning: "on", trigger: "routine", nudge: [[keep]] });
    await f.play([longTask]);
    expect(f.requests()).toHaveLength(1);
    expect(f.eventsOf("agent.skill.nudge")).toEqual([]);
  });
});
