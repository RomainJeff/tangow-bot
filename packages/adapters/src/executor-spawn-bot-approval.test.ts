import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { answerRunInput } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult, SPAWN_BOT_CANCELLED_RESULT } from "./approval-effect.js";
import type * as AutoReviewModule from "./auto-review.js";
import { runAutoReviewJudge } from "./auto-review.js";
import type * as ChildBotsModule from "./child-bots.js";
import { spawnBot } from "./child-bots.js";
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

vi.mock("./child-bots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildBotsModule>()),
  spawnBot: vi.fn(async (_deps: unknown, input: { name: string; title?: string }) => ({
    ok: true as const,
    botId: "child-1",
    name: input.name,
    title: input.title ?? "",
    threadId: "child-thread-1",
  })),
}));

const HOUR = 60 * 60 * 1000;

type Effect = {
  id: string;
  runId: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  createdAt: Date;
  updatedAt: Date;
  reviewDecision?: string;
};

type WorldRun = { id: string; botId: string; status: string };

/** ExternalEffect rows and runs shared by every executor of one test. */
function createWorld() {
  return { effects: [] as Effect[], runs: [] as WorldRun[], tick: 0, bots: [] as string[] };
}
type World = ReturnType<typeof createWorld>;

type Where = {
  id?: string;
  kind?: string;
  status?: string;
  runId?: string;
  idempotencyKey?: string | { not?: string };
  updatedAt?: { gte?: Date };
  run?: { botId?: string; status?: { in?: string[] } };
};

function matches(world: World, effect: Effect, where: Where = {}) {
  if (where.id && effect.id !== where.id) return false;
  if (where.kind && effect.kind !== where.kind) return false;
  if (where.status && effect.status !== where.status) return false;
  if (where.runId && effect.runId !== where.runId) return false;
  if (typeof where.idempotencyKey === "string" && effect.idempotencyKey !== where.idempotencyKey) {
    return false;
  }
  if (
    typeof where.idempotencyKey === "object" &&
    where.idempotencyKey.not &&
    effect.idempotencyKey === where.idempotencyKey.not
  ) {
    return false;
  }
  if (where.updatedAt?.gte && effect.updatedAt < where.updatedAt.gte) return false;
  if (where.run) {
    const owner = world.runs.find((candidate) => candidate.id === effect.runId);
    if (!owner) return false;
    if (where.run.botId && owner.botId !== where.run.botId) return false;
    if (where.run.status?.in && !where.run.status.in.includes(owner.status)) return false;
  }
  return true;
}

const SECRET = "hunter2-secret";

function fixture({
  world = createWorld(),
  runId = "run-1",
  botId = "bot-1",
  botName = "Assistant",
  trigger = "user",
  requireToolApproval = true,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  secrets = [SECRET],
  sourceMessage = undefined as { role: string; blocks: unknown[] } | undefined,
} = {}) {
  const { effects } = world;
  const results: unknown[] = [];
  const run = {
    id: runId,
    botId,
    threadId: `thread-${runId}`,
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    requireToolApproval,
    leaseFence: 0,
    sourceMessageId: sourceMessage ? "source-1" : null,
  };
  world.runs.push(run);
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
        orderBy,
        take,
      }: {
        where?: Where;
        orderBy?: Array<Record<string, "asc" | "desc">> | Record<string, "asc" | "desc">;
        take?: number;
      } = {}) => {
        const rows = effects.filter((effect) => matches(world, effect, where));
        if (orderBy) {
          rows.sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
        }
        return take ? rows.slice(0, take) : rows;
      },
    ),
    findFirst: vi.fn(
      async ({ where }: { where?: Where } = {}) =>
        effects.find((effect) => matches(world, effect, where)) ?? null,
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id" | "createdAt" | "updatedAt"> }) => {
      world.tick += 1;
      const at = new Date(Date.UTC(2026, 8, 29, 12, 0, 0, world.tick));
      const effect: Effect = {
        ...data,
        id: `effect-${String(world.tick).padStart(3, "0")}`,
        createdAt: at,
        updatedAt: at,
      };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (candidate) => candidate.id === where.id && candidate.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    ),
  };
  const botUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: botId,
    name: "Assistant",
    title: "Assistant",
    description: "Test assistant",
    ...data,
  }));
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: botId,
        name: botName,
        title: "Assistant",
        description: "Test assistant",
        spaceId: "space-1",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => world.bots.map((name) => ({ name }))),
      update: botUpdate,
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => (sourceMessage ? { id: "source-1", ...sourceMessage } : null)),
      findFirst: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Create a bot" })) },
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
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  type Call = { name?: string; args: Record<string, unknown>; executionId: string };
  let calls: Call[] = [];
  let parallel = false;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    const execute = async (call: Call) => {
      const result = await request.executeTool!(
        call.name ?? "spawn_bot",
        call.args,
        call.executionId,
      );
      results.push(result);
      return result;
    };
    if (parallel) {
      await Promise.all(calls.map(execute));
    } else {
      for (const call of calls) {
        if (isApprovalPausedResult(await execute(call))) return;
      }
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    world,
    run,
    effects,
    results,
    pauseRunForInput,
    botUpdate,
    setCalls(next: Call[], options: { parallel?: boolean } = {}) {
      calls = next;
      parallel = options.parallel ?? false;
    },
    /** The ask block of the most recent pause. */
    card() {
      const call = pauseRunForInput.mock.calls.at(-1) as unknown as
        | [{ blocks: Array<Record<string, unknown>> }]
        | undefined;
      return call?.[0].blocks[0];
    },
    async run_() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

const veille = {
  name: "Veille",
  title: "Watches competitors",
  instructions: "Track our competitors weekly.",
  prompt: "Start with the top three.",
  computer_mode: "dedicated",
};

function called() {
  return vi.mocked(spawnBot).mock.calls;
}

describe("spawn_bot approval in the executor", () => {
  beforeEach(() => {
    vi.mocked(spawnBot).mockClear();
    vi.mocked(runAutoReviewJudge).mockReset();
  });

  describe("CA2 the card appears for every trigger", () => {
    it.each([
      ["user", true],
      ["bot_message", true],
      ["routine", true],
      ["spawn", true],
      ["webhook", false],
    ])("pauses on an approval card for a %s run", async (trigger, requireToolApproval) => {
      const f = fixture({ trigger, requireToolApproval });
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();

      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(f.card()).toMatchObject({
        kind: "ask",
        text: "Create bot “Veille”?",
        approvalEffectId: f.effects[0]!.id,
        actions: [
          { id: "allow", label: "Create bot", outcome: "created" },
          { id: "deny", label: "Cancel", outcome: "cancelled" },
        ],
        spawnBot: {
          name: "Veille",
          title: "Watches competitors",
          instructions: "Track our competitors weekly.",
          prompt: "Start with the top three.",
          computerMode: "dedicated",
        },
      });
      expect(called()).toHaveLength(0);
    });
  });

  describe("CA3 nothing skips the card", () => {
    it("ignores an always_allow rule", async () => {
      const f = fixture({
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "spawn_bot" }],
      });
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(called()).toHaveLength(0);
    });

    it("ignores an auto-review judge that passes", async () => {
      vi.mocked(runAutoReviewJudge).mockResolvedValue({
        decision: "pass",
        reason: "fine",
        model: "scripted/checker",
      });
      const f = fixture({ autoReview: true });
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(runAutoReviewJudge).not.toHaveBeenCalled();
      expect(called()).toHaveLength(0);
    });
  });

  describe("CA5 validation happens before any effect or card", () => {
    it.each([
      ["an empty name", { name: "  " }, []],
      ["a name over 80 characters", { name: "n".repeat(81) }, []],
      ["a name held by an active bot", { name: "  VEILLE " }, ["Veille"]],
      ["a hidden character", { instructions: "Do this\u200B quietly" }, []],
      ["a link-shaped name", { name: "[Fiable](https://e.example)" }, []],
      ["a multi-line title", { title: "one\ntwo" }, []],
      ["instructions over 3000 characters", { instructions: "i".repeat(3001) }, []],
      ["a prompt over 1000 characters", { prompt: "p".repeat(1001) }, []],
      ["an unknown computer mode", { computer_mode: "shared" }, []],
    ])("refuses %s without an effect or a card", async (_label, patch, bots) => {
      const world = createWorld();
      world.bots = bots;
      const f = fixture({ world });
      f.setCalls([{ args: { ...veille, ...patch }, executionId: "call-1" }]);
      await f.run_();

      expect(f.results[0]).toEqual({ error: expect.any(String) });
      expect(f.effects).toHaveLength(0);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(called()).toHaveLength(0);
    });
  });

  describe("CA6 what is created is what the card showed", () => {
    it("creates one bot with the card fields even if the model resends other arguments", async () => {
      const f = fixture();
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";

      f.setCalls([
        { args: { name: "Something else", instructions: "Evil" }, executionId: "call-2" },
      ]);
      await f.run_();

      expect(called()).toHaveLength(1);
      expect(called()[0]![1]).toMatchObject({
        name: "Veille",
        title: "Watches competitors",
        instructions: "Track our competitors weekly.",
        prompt: "Start with the top three.",
        computerMode: "dedicated",
        spawnKey: f.effects[0]!.id,
      });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toMatchObject({ ok: true, botId: "child-1" });

      // A replay of the whole turn returns the stored result and creates nothing more.
      f.setCalls([{ args: veille, executionId: "call-3" }]);
      await f.run_();
      expect(called()).toHaveLength(1);
      expect(f.effects).toHaveLength(1);
      expect(f.results.at(-1)).toMatchObject({ ok: true, botId: "child-1" });
    });

    it("creates nothing after Cancel and tells the bot it was a cancellation", async () => {
      const f = fixture();
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      f.effects[0]!.status = "denied";

      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();

      expect(called()).toHaveLength(0);
      expect(f.results.at(-1)).toEqual(SPAWN_BOT_CANCELLED_RESULT);
      expect(f.results.at(-1)).toMatchObject({ ok: false, cancelled: true });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });
  });

  describe("CA7 one card at a time", () => {
    it("refuses a second request while a card waits, from another run of the same bot", async () => {
      const first = fixture({ runId: "run-a" });
      first.setCalls([{ args: veille, executionId: "call-1" }]);
      await first.run_();
      expect(first.run.status).toBe("waiting_input");

      const second = fixture({ world: first.world, runId: "run-b" });
      second.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-2" }]);
      await second.run_();

      expect(second.results[0]).toEqual({ error: expect.stringContaining("already waiting") });
      expect(second.pauseRunForInput).not.toHaveBeenCalled();
      expect(first.effects).toHaveLength(1);
    });

    it("does not let another bot's card block this bot", async () => {
      const first = fixture({ runId: "run-a", botId: "bot-1" });
      first.setCalls([{ args: veille, executionId: "call-1" }]);
      await first.run_();

      const other = fixture({ world: first.world, runId: "run-b", botId: "bot-2" });
      other.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-2" }]);
      await other.run_();
      expect(other.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("refuses another request in the same run after a Cancel", async () => {
      const f = fixture();
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      f.effects[0]!.status = "denied";

      f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-2" }]);
      await f.run_();

      expect(f.results.at(-1)).toEqual(SPAWN_BOT_CANCELLED_RESULT);
      expect(f.effects).toHaveLength(1);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("shows a card again in a later run once nothing is pending", async () => {
      const first = fixture({ runId: "run-a" });
      first.setCalls([{ args: veille, executionId: "call-1" }]);
      await first.run_();
      first.effects[0]!.status = "approved";
      first.setCalls([{ args: veille, executionId: "call-2" }]);
      await first.run_();
      expect(first.effects[0]!.status).toBe("completed");

      const later = fixture({ world: first.world, runId: "run-c" });
      later.setCalls([{ args: { ...veille, name: "Suite" }, executionId: "call-3" }]);
      await later.run_();
      expect(later.pauseRunForInput).toHaveBeenCalledOnce();
      expect(later.card()).toMatchObject({ text: "Create bot “Suite”?" });
    });
  });

  describe("CA8 secrets never reach the effect, the card or the bot", () => {
    it("masks a run secret in spawn_bot instructions and prompt", async () => {
      const f = fixture();
      f.setCalls([
        {
          args: {
            ...veille,
            instructions: `Use key ${SECRET} always`,
            prompt: `Start with ${SECRET}`,
          },
          executionId: "call-1",
        },
      ]);
      await f.run_();

      expect(JSON.stringify(f.effects[0]!.request)).not.toContain(SECRET);
      expect(JSON.stringify(f.card())).not.toContain(SECRET);
      expect(JSON.stringify(f.card())).toContain("[redacted]");

      f.effects[0]!.status = "approved";
      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();
      expect(called()).toHaveLength(1);
      expect(JSON.stringify(called()[0]![1])).not.toContain(SECRET);
      expect(called()[0]![1]).toMatchObject({
        instructions: "Use key [redacted] always",
        prompt: "Start with [redacted]",
      });
    });

    it("masks a run secret in update_bot description, stored request and patch", async () => {
      const f = fixture();
      f.setCalls([
        {
          name: "update_bot",
          args: { description: `Talks to ${SECRET} daily` },
          executionId: "call-1",
        },
      ]);
      await f.run_();

      expect(JSON.stringify(f.effects[0]!.request)).not.toContain(SECRET);
      expect(f.botUpdate).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.botUpdate.mock.calls[0])).not.toContain(SECRET);
      expect(f.botUpdate.mock.calls[0]![0]).toMatchObject({
        data: { description: "Talks to [redacted] daily" },
      });
    });
  });

  describe("CA25 a replay never trips over its own name", () => {
    it("settles an approved effect whose name was taken meanwhile with an error", async () => {
      const world = createWorld();
      const f = fixture({ world });
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      f.effects[0]!.status = "approved";
      world.bots = ["veille"];

      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();

      expect(called()).toHaveLength(0);
      expect(f.results.at(-1)).toEqual({ error: expect.stringContaining("already exists") });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.effects[0]!.result).toEqual({ error: expect.stringContaining("already exists") });
    });

    it("returns the stored result of a completed effect although its bot now holds the name", async () => {
      const world = createWorld();
      const f = fixture({ world });
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();
      expect(called()).toHaveLength(1);
      world.bots = ["Veille"];

      f.setCalls([{ args: veille, executionId: "call-3" }]);
      await f.run_();

      expect(called()).toHaveLength(1);
      expect(f.results.at(-1)).toMatchObject({ ok: true, botId: "child-1" });
      expect(f.effects).toHaveLength(1);
    });

    it("keeps the approval key on the canonical arguments", async () => {
      const f = fixture();
      f.setCalls([{ args: { ...veille, name: "  Veille  " }, executionId: "call-1" }]);
      await f.run_();
      expect(f.effects[0]!.idempotencyKey).toBe(approvalEffectKey("run-1", "spawn_bot", veille));
    });
  });

  describe("CA26 the guard follows live runs and races", () => {
    it.each(["queued", "leased", "running", "waiting_input", "waiting_takeover"])(
      "is blocked by a %s run that kept an intended effect",
      async (status) => {
        const world = createWorld();
        world.runs.push({ id: "old-run", botId: "bot-1", status });
        world.effects.push({
          id: "effect-old",
          runId: "old-run",
          kind: "spawn_bot",
          idempotencyKey: "old-key",
          status: "intended",
          request: veille,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        });
        const f = fixture({ world });
        f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-1" }]);
        await f.run_();
        expect(f.pauseRunForInput).not.toHaveBeenCalled();
        expect(f.results[0]).toEqual({ error: expect.stringContaining("already waiting") });
      },
    );

    it.each(["cancelled", "completed", "failed"])(
      "is not blocked by a %s run that kept an intended effect",
      async (status) => {
        const world = createWorld();
        world.runs.push({ id: "old-run", botId: "bot-1", status });
        world.effects.push({
          id: "effect-old",
          runId: "old-run",
          kind: "spawn_bot",
          idempotencyKey: "old-key",
          status: "intended",
          request: veille,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        });
        const f = fixture({ world });
        f.setCalls([{ args: veille, executionId: "call-1" }]);
        await f.run_();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      },
    );

    it("shows one card for two concurrent requests in the same run", async () => {
      const f = fixture();
      f.setCalls(
        [
          { args: veille, executionId: "call-1" },
          { args: { ...veille, name: "Autre" }, executionId: "call-2" },
        ],
        { parallel: true },
      );
      await f.run_();

      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      const refused = f.results.filter((result) => !isApprovalPausedResult(result)) as Array<{
        error?: string;
      }>;
      expect(refused).toHaveLength(1);
      expect(refused[0]!.error).toContain("already waiting");
      const intended = f.effects.filter((effect) => effect.status === "intended");
      expect(intended).toHaveLength(1);
      expect(f.effects.filter((effect) => effect.status === "completed")).toHaveLength(
        f.effects.length - 1,
      );
    });

    it("shows one card for two concurrent requests in two runs of the same bot", async () => {
      const a = fixture({ runId: "run-a" });
      const b = fixture({ world: a.world, runId: "run-b" });
      a.setCalls([{ args: veille, executionId: "call-1" }]);
      b.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-2" }]);
      await Promise.all([a.run_(), b.run_()]);

      expect(a.pauseRunForInput.mock.calls.length + b.pauseRunForInput.mock.calls.length).toBe(1);
      expect(a.world.effects.filter((effect) => effect.status === "intended")).toHaveLength(1);
    });
  });

  describe("CA29 validation runs after masking", () => {
    it("refuses a request that a one-character secret inflates past the limit", async () => {
      const f = fixture({ secrets: ["1"] });
      f.setCalls([{ args: { ...veille, instructions: "1".repeat(400) }, executionId: "call-1" }]);
      await f.run_();
      expect(f.results[0]).toEqual({ error: expect.stringContaining("instructions must be") });
      expect(f.effects).toHaveLength(0);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("keeps the card under 5000 characters when the masked request still fits", async () => {
      const f = fixture({ secrets: ["1"] });
      f.setCalls([{ args: { ...veille, instructions: "1".repeat(100) }, executionId: "call-1" }]);
      await f.run_();
      const card = f.card() as { text: string; detail: string };
      expect(card.text.length + card.detail.length).toBeLessThan(5_000);
      expect(card.detail).toContain("[redacted]");
    });
  });

  describe("CA30 a Cancel silences unattended bots for 24 hours", () => {
    function withCancelledCard(hoursAgo: number) {
      const world = createWorld();
      world.runs.push({ id: "old-run", botId: "bot-1", status: "completed" });
      const at = new Date(Date.now() - hoursAgo * HOUR);
      world.effects.push({
        id: "effect-old",
        runId: "old-run",
        kind: "spawn_bot",
        idempotencyKey: "old-key",
        status: "denied",
        request: veille,
        createdAt: at,
        updatedAt: at,
      });
      return world;
    }

    it.each([
      ["bot_message", true],
      ["routine", true],
      ["webhook", false],
      ["spawn", true],
    ])("refuses a %s run within 24 hours of a Cancel", async (trigger, requireToolApproval) => {
      const f = fixture({ world: withCancelledCard(1), trigger, requireToolApproval });
      f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-1" }]);
      await f.run_();

      expect(f.results[0]).toEqual(SPAWN_BOT_CANCELLED_RESULT);
      expect(f.effects).toHaveLength(1);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("still asks the user who types the request themselves", async () => {
      const f = fixture({ world: withCancelledCard(1), trigger: "user" });
      f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-1" }]);
      await f.run_();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("still asks the user who follows up in a call or while the bot works", async () => {
      const f = fixture({
        world: withCancelledCard(1),
        trigger: "follow_up",
        sourceMessage: { role: "user", blocks: [{ kind: "text", text: "Create it as Autre" }] },
      });
      f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-1" }]);
      await f.run_();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("refuses a group handoff, which is a follow-up a bot sent", async () => {
      const f = fixture({
        world: withCancelledCard(1),
        trigger: "follow_up",
        sourceMessage: {
          role: "bot",
          blocks: [{ kind: "handoff", fromBotId: "bot-2", toBotId: "bot-1", text: "Go", hop: 1 }],
        },
      });
      f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-1" }]);
      await f.run_();
      expect(f.results[0]).toEqual(SPAWN_BOT_CANCELLED_RESULT);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("lets an unattended bot ask again after 24 hours", async () => {
      const f = fixture({ world: withCancelledCard(25), trigger: "routine" });
      f.setCalls([{ args: { ...veille, name: "Autre" }, executionId: "call-1" }]);
      await f.run_();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });
  });

  describe("an edited card is replayed from the stored request", () => {
    /** The answer transaction of @rakazo/db, run against the rows this test's executor uses. */
    function answerCard(
      f: ReturnType<typeof fixture>,
      edits: { name?: string; instructions?: string } | undefined,
    ) {
      const events: Array<{ type: string; payload: unknown }> = [];
      const tx = {
        $queryRaw: async () => [],
        run: {
          findFirst: async () => ({ botId: "bot-1", userId: "user-1", checkpoint: null }),
          findUnique: async () => ({ status: "queued", startedAt: null }),
          updateMany: async () => ({ count: 1 }),
        },
        message: {
          findFirst: async () => ({ id: "message-1", blocks: [f.card()] }),
          update: async () => ({}),
        },
        externalEffect: {
          findFirst: async ({ where }: { where: Where }) =>
            f.effects.find((effect) => matches(f.world, effect, where)) ?? null,
          findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
            f.effects.find((effect) => effect.idempotencyKey === where.idempotencyKey) ?? null,
          updateMany: async ({
            where,
            data,
          }: {
            where: { id: string; status: string; idempotencyKey: string };
            data: Partial<Effect>;
          }) => {
            const effect = f.effects.find(
              (candidate) =>
                candidate.id === where.id &&
                candidate.status === where.status &&
                candidate.idempotencyKey === where.idempotencyKey,
            );
            if (!effect) return { count: 0 };
            Object.assign(effect, data);
            return { count: 1 };
          },
          update: async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
            Object.assign(f.effects.find((effect) => effect.id === where.id)!, data);
          },
        },
        bot: { findMany: async () => f.world.bots.map((name) => ({ name })) },
        task: { updateMany: async () => ({ count: 1 }) },
        thread: { update: async () => ({ nextEventSeq: 10 + events.length }) },
        event: {
          create: async ({ data }: { data: { type: string; payload: unknown; seq: number } }) => {
            events.push({ type: data.type, payload: data.payload });
            return { id: `event-${data.seq}`, threadId: "thread-run-1", seq: data.seq };
          },
        },
      };
      const prisma = {
        $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
      } as unknown as PrismaClient;
      return {
        events,
        answered: answerRunInput(prisma, {
          spaceId: "space-1",
          threadId: "thread-run-1",
          runId: "run-1",
          messageId: "message-1",
          answeredByUserId: "user-1",
          answer: "allow",
          ...(edits ? { edits } : {}),
        }),
      };
    }

    it("CA5 creates one bot with the edited name and instructions and no new card", async () => {
      const f = fixture();
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();

      const { answered, events } = answerCard(f, {
        name: "Radar",
        instructions: "Watch our competitors daily.",
      });
      await expect(answered).resolves.toBe(true);
      expect(events.map((event) => event.type)).toEqual([
        "effect.edited",
        "thread.message.updated",
      ]);
      expect(events[0]!.payload).toEqual({
        effectId: f.effects[0]!.id,
        proposed: veille,
        approved: { ...veille, name: "Radar", instructions: "Watch our competitors daily." },
      });

      // The model resumes with the arguments it first proposed.
      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();

      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(called()).toHaveLength(1);
      expect(called()[0]![1]).toMatchObject({
        name: "Radar",
        title: "Watches competitors",
        instructions: "Watch our competitors daily.",
        prompt: "Start with the top three.",
        computerMode: "dedicated",
        spawnKey: f.effects[0]!.id,
      });
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toMatchObject({ ok: true, botId: "child-1", name: "Radar" });
    });

    it("CA19 keeps the stored key equal to the approval key and replays as a duplicate", async () => {
      const f = fixture();
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      const { answered } = answerCard(f, { name: "Radar" });
      await answered;

      const effect = f.effects[0]!;
      expect(effect.idempotencyKey).toBe(
        approvalEffectKey("run-1", "spawn_bot", effect.request as Record<string, unknown>),
      );
      expect(effect.request).toEqual({ ...veille, name: "Radar" });
      expect(effect.status).toBe("approved");

      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();
      // Replaying the whole turn again finds the effect by its new key: nothing more happens.
      f.setCalls([{ args: { ...veille, name: "Radar" }, executionId: "call-3" }]);
      await f.run_();

      expect(f.effects).toHaveLength(1);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(called()).toHaveLength(1);
      expect(f.results.at(-1)).toMatchObject({ ok: true, botId: "child-1", name: "Radar" });
    });

    it("CA24 creates the same bot from an answer without edits", async () => {
      const f = fixture();
      f.setCalls([{ args: veille, executionId: "call-1" }]);
      await f.run_();
      const { answered, events } = answerCard(f, undefined);
      await answered;
      expect(events.map((event) => event.type)).toEqual(["thread.message.updated"]);

      f.setCalls([{ args: veille, executionId: "call-2" }]);
      await f.run_();
      expect(called()).toHaveLength(1);
      expect(called()[0]![1]).toMatchObject({
        name: "Veille",
        instructions: "Track our competitors weekly.",
      });
    });
  });

  describe("CA22 update_bot uses the same name rule", () => {
    it.each(["Alice\u200B", "ALICE ", "\uFF41\uFF4C\uFF49\uFF43\uFF45"])(
      "refuses renaming to %j while Alice is active",
      async (name) => {
        const world = createWorld();
        world.bots = ["Alice"];
        const f = fixture({ world });
        f.setCalls([{ name: "update_bot", args: { name }, executionId: "call-1" }]);
        await f.run_();
        expect(f.results[0]).toEqual({ error: expect.any(String) });
        expect(f.botUpdate).not.toHaveBeenCalled();
        expect(f.effects[0]!.status).toBe("completed");
      },
    );

    it("refuses a hidden character in the new name and allows a free name", async () => {
      const f = fixture();
      f.setCalls([
        { name: "update_bot", args: { name: "Bo\u202Eb" }, executionId: "call-1" },
        { name: "update_bot", args: { name: "Bob" }, executionId: "call-2" },
      ]);
      await f.run_();
      expect(f.results[0]).toEqual({ error: expect.any(String) });
      expect(f.botUpdate).toHaveBeenCalledOnce();
      expect(f.botUpdate.mock.calls[0]![0]).toMatchObject({ data: { name: "Bob" } });
    });

    it("does not promote a title into the name of a teammate", async () => {
      const world = createWorld();
      world.bots = ["Alice"];
      const f = fixture({ world, botName: "New Bot" });
      f.setCalls([{ name: "update_bot", args: { title: "alice" }, executionId: "call-1" }]);
      await f.run_();
      expect(f.botUpdate).toHaveBeenCalledOnce();
      const { data } = f.botUpdate.mock.calls[0]![0];
      expect(data).toEqual({ title: "alice" });
    });

    it("promotes a free title into the name of a placeholder bot", async () => {
      const f = fixture({ botName: "New Bot" });
      f.setCalls([{ name: "update_bot", args: { title: "Scout" }, executionId: "call-1" }]);
      await f.run_();
      expect(f.botUpdate.mock.calls[0]![0]).toMatchObject({
        data: { title: "Scout", name: "Scout" },
      });
    });
  });
});
