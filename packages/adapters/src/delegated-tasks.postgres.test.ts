import { randomUUID } from "node:crypto";
import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { AuthorizedActor, CommandContext } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessageInTransaction } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";
import {
  createDelegatedTasks,
  DelegationLimitError,
  recordSpecialistFailure,
  recordSpecialistResult,
  WorkClosedError,
  WorkHasOpenDescendantsError,
} from "./delegated-tasks.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createJobReconciler } from "./job-reconciler.js";
import { createNativeSessionStore } from "./native-session-store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// NOT RUN in this sandbox (no Docker/Postgres). Terra runs this at review with:
//   VERIFY_DATABASE=1 DATABASE_URL=<test db> pnpm exec vitest run packages/adapters/src/delegated-tasks.postgres.test.ts
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("DelegatedTasks.apply/inspect (PostgreSQL contract)", () => {
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const orgIds: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.scopedTask.deleteMany({ where: { userId: { in: orgIds } } });
    await prisma.botMcpServer.deleteMany({ where: { userId: { in: orgIds } } });
    await prisma.mcpServer.deleteMany({ where: { userId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: orgIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function setup() {
    const id = randomUUID();
    orgIds.push(id);
    await prisma.user.create({
      data: { id, name: "T04 test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "T04 test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "T04 test", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const missionComputer = await prisma.computer.create({
      data: {
        spaceId: id,
        userId: id,
        scopeKey: `t04-mission-scope-${id}`,
        homeKey: `t04-mission-home-${id}`,
        kind: "fake",
      },
    });
    const coordinator = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Coordinator", color: "test-color" },
    });
    await prisma.bot.update({
      where: { id: coordinator.id },
      data: { computerId: missionComputer.id },
    });
    const coordinatorThread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: coordinator.id },
    });
    const profile = await prisma.bot.create({
      data: {
        spaceId: id,
        userId: id,
        name: "Analyst profile",
        color: "test-color",
        modelProvider: "openai-codex",
        modelId: "gpt-5.6",
        thinkingLevel: "low",
      },
    });
    const originTask = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: coordinator.id,
        threadId: coordinatorThread.id,
        prompt: "delegate",
        status: "running",
      },
    });
    const originRun = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: coordinator.id,
        threadId: coordinatorThread.id,
        taskId: originTask.id,
        status: "running",
        trigger: "user",
      },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma,
      jobs: { enqueue } as unknown as JobPublisher,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
    };
    const actor: AuthorizedActor = {
      userId: id,
      spaceId: id,
      botId: coordinator.id,
      rights: { canReadFiles: true },
    };
    const context: CommandContext = { actor, originRunId: originRun.id, requestId: randomUUID() };
    return {
      id,
      coordinator,
      missionComputer,
      coordinatorThread,
      profile,
      originRun,
      deps,
      actor,
      context,
      enqueue,
    };
  }

  /** The specialist's Runs have ended, so its task is finished work that can be closed. */
  const finishRuns = (workId: string) =>
    prisma.run.updateMany({
      where: { scopedTaskId: workId, status: { in: ["queued", "leased", "running"] } },
      data: { status: "completed" },
    });

  /** A specialist's native turn as the executor records it, then a stop nothing confirmed. */
  async function seedUnconfirmedNativeStop(
    receipt: { workId: string; botId: string; threadId: string },
    executionTarget: string,
    processRef: string,
  ) {
    const store = createNativeSessionStore(prisma);
    const ref = { bindingId: receipt.threadId, generation: 0 };
    await store.record({
      botId: receipt.botId,
      threadId: receipt.threadId,
      scopedTaskId: receipt.workId,
      ref,
      nativeRef: "t08-native-thread",
      processRef,
      harness: "codex-native",
      executionTarget,
      continuity: "new",
    });
    await store.stopUnconfirmed({ botId: receipt.botId, threadId: receipt.threadId, ref });
  }

  it("creates an inspectable work identity, replays idempotently, then runs scenario 2", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const spawnKey = `spawn-${randomUUID()}`;

    // T07:6 (B5): the coordinator holds a real, wider MCP assignment; the delegate call
    // explicitly requests a narrower subset of it. The persisted ceiling must equal the
    // request (request ∩ coordinator's effective access, and the request is a strict
    // subset here so the intersection is just the request), never the coordinator's full
    // access — this exercises the real narrowing path against Postgres, not a fake.
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        slug: `server-${s.id}`,
        name: "Test connector",
        transport: "stdio",
        enabled: true,
      },
    });
    await prisma.botMcpServer.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        botId: s.coordinator.id,
        serverId: server.id,
        allowAllTools: false,
        allowedTools: ["search", "write"],
      },
    });
    const requestedRights = { [server.id]: { allowAllTools: false, allowedTools: ["search"] } };

    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Summarize the quarterly report",
        requestedRights,
        spawnKey,
      },
      s.context,
    );

    expect(receipt.replayed).toBe(false);
    expect(receipt.runId).toBeTruthy();
    // The specialist may use the coordinator's mission Computer without taking ownership.
    // This is deliberately a real-Postgres assertion: the executor's provisioning claim
    // relies on this durable grant rather than a mock-only relationship.
    const specialist = await prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId } });
    expect(specialist.computerId).not.toBe(s.missionComputer.id);
    await expect(
      prisma.computerUsageGrant.findUnique({
        where: { computerId_botId: { computerId: s.missionComputer.id, botId: receipt.botId } },
      }),
    ).resolves.toMatchObject({ computerId: s.missionComputer.id, botId: receipt.botId });

    const tree = await tasks.inspect(receipt.workId, s.actor);
    expect(tree.root.coordinator).toEqual({
      botId: s.coordinator.id,
      threadId: s.coordinatorThread.id,
    });
    expect(tree.root.executor.botId).toBe(receipt.botId);
    expect(tree.root.parentScopedTaskId).toBeNull();
    expect(tree.root.rootScopedTaskId).toBe(receipt.workId);
    expect(tree.root.delegationCeiling).toEqual(requestedRights);

    // Idempotence: replaying the same spawnKey must not create a second specialist.
    const specialistCountBefore = await s.deps.prisma.bot.count({
      where: { parentBotId: s.coordinator.id },
    });
    const replay = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Summarize the quarterly report",
        requestedRights,
        spawnKey,
      },
      s.context,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.workId).toBe(receipt.workId);
    const specialistCountAfter = await s.deps.prisma.bot.count({
      where: { parentBotId: s.coordinator.id },
    });
    expect(specialistCountAfter).toBe(specialistCountBefore);

    // Scenario 2: a result does not close the task; a complément runs the same
    // specialist and delivers a second return to the coordinator thread.
    await recordSpecialistResult(s.deps, {
      workId: receipt.workId,
      runId: receipt.runId!,
      text: "First result.",
    });
    const afterResult = await tasks.inspect(receipt.workId, s.actor);
    expect(afterResult.root.status).not.toBe("closed");

    const followup = await tasks.apply(
      { kind: "followup", workId: receipt.workId, text: "Now break it down by region." },
      s.context,
    );
    expect(followup.threadId).toBe(receipt.threadId);
    await recordSpecialistResult(s.deps, {
      workId: receipt.workId,
      runId: followup.runId!,
      text: "Second result.",
    });

    const coordinatorReturns = await s.deps.prisma.message.findMany({
      where: { threadId: s.coordinatorThread.id, role: "bot" },
      orderBy: { seq: "asc" },
    });
    expect(coordinatorReturns).toHaveLength(2);

    // A returned result remains follow-upable (and therefore keeps the grant). Explicitly
    // closing the work is the non-reopenable terminal transition that revokes it.
    await finishRuns(receipt.workId);
    await tasks.apply({ kind: "close", workId: receipt.workId }, s.context);
    await expect(
      prisma.computerUsageGrant.findUnique({
        where: { computerId_botId: { computerId: s.missionComputer.id, botId: receipt.botId } },
      }),
    ).resolves.toBeNull();
    await expect(
      tasks.apply({ kind: "followup", workId: receipt.workId, text: "Too late." }, s.context),
    ).rejects.toThrow(/closed/);
  });

  it("delivers one coordinator message and one realtime event when a result is retried", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Return this result once.",
        requestedRights: {},
        spawnKey: `realtime-return-${randomUUID()}`,
      },
      s.context,
    );

    const input = { workId: receipt.workId, runId: receipt.runId!, text: "Completed." };
    const announcedBefore = s.deps.events.notify.mock.calls.length;
    await recordSpecialistResult(s.deps, input);
    await recordSpecialistResult(s.deps, input);

    await expect(
      prisma.message.count({ where: { threadId: s.coordinatorThread.id, runId: receipt.runId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.event.count({
        where: {
          threadId: s.coordinatorThread.id,
          runId: receipt.runId,
          type: "thread.message.created",
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.run.count({
        where: {
          botId: s.coordinator.id,
          threadId: s.coordinatorThread.id,
          trigger: "work_return",
        },
      }),
    ).resolves.toBe(1);
    // A bot thread's messages and events belong to its owner, never to the specialist.
    const coordinatorBotId = (
      await prisma.scopedTask.findUniqueOrThrow({ where: { id: receipt.workId } })
    ).coordinatorBotId;
    await expect(
      prisma.message.findFirstOrThrow({
        where: { threadId: s.coordinatorThread.id, runId: receipt.runId },
      }),
    ).resolves.toMatchObject({ botId: coordinatorBotId });
    await expect(
      prisma.event.findFirstOrThrow({
        where: {
          threadId: s.coordinatorThread.id,
          runId: receipt.runId,
          type: "thread.message.created",
        },
      }),
    ).resolves.toMatchObject({ botId: coordinatorBotId });
    expect(s.deps.events.notify).toHaveBeenCalledTimes(announcedBefore + 1);
  });

  it("serializes two concurrent deliveries of the same specialist result", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Deliver this result concurrently.",
        requestedRights: {},
        spawnKey: `concurrent-return-${randomUUID()}`,
      },
      s.context,
    );
    const db2 = createDb(process.env.DATABASE_URL!);
    const lockDb = createDb(process.env.DATABASE_URL!);
    const order: string[] = [];
    let releaseLock: () => void = () => {};
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = lockDb.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM scoped_tasks WHERE id = ${receipt.workId} FOR UPDATE`;
      order.push("scoped-task-locked");
      await lockReleased;
    });

    try {
      const lockDeadline = Date.now() + 5_000;
      while (!order.includes("scoped-task-locked")) {
        if (Date.now() > lockDeadline) throw new Error("concurrent delivery lock was not acquired");
        await sleep(5);
      }
      const input = { workId: receipt.workId, runId: receipt.runId!, text: "Completed." };
      const secondDeps = {
        ...s.deps,
        prisma: db2.prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) },
      };
      const deliveries = Promise.all([
        recordSpecialistResult(s.deps, input),
        recordSpecialistResult(secondDeps, input),
      ]);

      const waitDeadline = Date.now() + 3_000;
      let concurrentLockWaits = 0;
      while (Date.now() < waitDeadline) {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active'`;
        concurrentLockWaits = Number(rows[0]?.count ?? 0);
        if (concurrentLockWaits >= 2) break;
        await sleep(5);
      }
      expect(concurrentLockWaits).toBeGreaterThanOrEqual(2);

      releaseLock();
      await Promise.all([locked, deliveries]);
      await expect(
        prisma.message.count({ where: { threadId: s.coordinatorThread.id, runId: receipt.runId } }),
      ).resolves.toBe(1);
      await expect(
        prisma.event.count({
          where: {
            threadId: s.coordinatorThread.id,
            runId: receipt.runId,
            type: "thread.message.created",
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.run.count({
          where: {
            botId: s.coordinator.id,
            threadId: s.coordinatorThread.id,
            trigger: "work_return",
          },
        }),
      ).resolves.toBe(1);
    } finally {
      releaseLock();
      await locked.catch(() => undefined);
      await db2.prisma.$disconnect();
      await db2.pool.end();
      await lockDb.prisma.$disconnect();
      await lockDb.pool.end();
    }
  });

  it("wakes the coordinator after a failed specialist return but not after close", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Return a failure once.",
        requestedRights: {},
        spawnKey: `failed-return-${randomUUID()}`,
      },
      s.context,
    );

    await recordSpecialistFailure(s.deps, { workId: receipt.workId, runId: receipt.runId! });
    await expect(
      prisma.run.count({
        where: {
          botId: s.coordinator.id,
          threadId: s.coordinatorThread.id,
          trigger: "work_return",
        },
      }),
    ).resolves.toBe(1);

    await finishRuns(receipt.workId);
    await tasks.apply({ kind: "close", workId: receipt.workId }, s.context);
    const originalRun = await prisma.run.findUniqueOrThrow({
      where: { id: receipt.runId! },
      select: { taskId: true },
    });
    const lateRun = await prisma.run.create({
      data: {
        spaceId: s.id,
        botId: receipt.botId,
        threadId: receipt.threadId,
        taskId: originalRun.taskId,
        userId: s.id,
        status: "failed",
        trigger: "delegate_followup",
        scopedTaskId: receipt.workId,
      },
    });
    await recordSpecialistFailure(s.deps, { workId: receipt.workId, runId: lateRun.id });
    await expect(
      prisma.run.count({
        where: {
          botId: s.coordinator.id,
          threadId: s.coordinatorThread.id,
          trigger: "work_return",
        },
      }),
    ).resolves.toBe(1);
  });

  it("wakes a specialist coordinator on its own task and engine, not its descendant's", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const root = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Prepare the summary",
        requestedRights: {},
        spawnKey: `wake-root-${randomUUID()}`,
      },
      s.context,
    );
    const { receipt: child } = await delegateChild(s, root, `wake-child-${randomUUID()}`);
    await prisma.scopedTask.update({
      where: { id: child.workId },
      data: { harness: "claude-native" },
    });

    await recordSpecialistResult(s.deps, {
      workId: child.workId,
      runId: child.runId!,
      text: "The section is done.",
    });

    await expect(
      prisma.run.findFirstOrThrow({ where: { botId: root.botId, trigger: "work_return" } }),
    ).resolves.toMatchObject({ scopedTaskId: root.workId, harness: "codex-native" });
    // A persistent coordinator's wake carries no choice: the executor resolves its own.
    await recordSpecialistResult(s.deps, {
      workId: root.workId,
      runId: root.runId!,
      text: "The summary is done.",
    });
    await expect(
      prisma.run.findFirstOrThrow({
        where: { botId: s.coordinator.id, trigger: "work_return" },
      }),
    ).resolves.toMatchObject({ scopedTaskId: null, harness: null });
  });

  it("groups delivered returns into one wake prompt as untrusted specialist output", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Return twice.",
        requestedRights: {},
        spawnKey: `grouped-return-${randomUUID()}`,
      },
      s.context,
    );
    await recordSpecialistResult(s.deps, {
      workId: receipt.workId,
      runId: receipt.runId!,
      text: "First specialist result.",
    });
    const original = await prisma.run.findUniqueOrThrow({
      where: { id: receipt.runId! },
      select: { taskId: true },
    });
    const secondRun = await prisma.run.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        botId: receipt.botId,
        threadId: receipt.threadId,
        taskId: original.taskId,
        status: "failed",
        trigger: "delegate_followup",
        scopedTaskId: receipt.workId,
      },
    });
    await recordSpecialistFailure(s.deps, { workId: receipt.workId, runId: secondRun.id });

    const wakes = await prisma.run.findMany({
      where: {
        botId: s.coordinator.id,
        threadId: s.coordinatorThread.id,
        trigger: "work_return",
      },
      include: { task: { select: { prompt: true } } },
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.task.prompt).toContain("Analyst");
    expect(wakes[0]!.task.prompt).toContain("First specialist result.");
    expect(wakes[0]!.task.prompt).toContain("The specialist run failed to complete.");
    expect(wakes[0]!.task.prompt).toContain("UNTRUSTED SPECIALIST OUTPUT");
  });

  it("copies an inherited profile default and refuses an incompatible native harness before spawn", async () => {
    const s = await setup();
    const credential = await prisma.userModelCredential.create({
      data: {
        userId: s.id,
        provider: "openai-codex",
        label: "ChatGPT",
        secretId: `secret-${s.id}`,
      },
    });
    await prisma.spaceModelPreference.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        credentialId: credential.id,
        modelId: "gpt-5.6",
        isDefault: true,
      },
    });
    const inherited = await prisma.bot.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        name: "Inherited profile",
        color: "test-color",
      },
    });
    const tasks = createDelegatedTasks(s.deps);
    const inheritedReceipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: inherited.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Summarize the quarterly report",
        requestedRights: {},
        spawnKey: `inherited-${randomUUID()}`,
      },
      s.context,
    );
    await expect(
      prisma.bot.findUniqueOrThrow({ where: { id: inheritedReceipt.botId } }),
    ).resolves.toMatchObject({
      modelProvider: "openai-codex",
      modelId: "gpt-5.6",
      thinkingLevel: "medium",
    });

    const incompatible = await prisma.bot.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        name: "Incompatible profile",
        color: "test-color",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5",
        thinkingLevel: "medium",
      },
    });
    const before = await prisma.bot.count({ where: { parentBotId: s.coordinator.id } });
    await expect(
      tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: incompatible.id, name: "Analyst" },
          harness: "codex-native",
          brief: "Summarize the quarterly report",
          requestedRights: {},
          spawnKey: `incompatible-${randomUUID()}`,
        },
        s.context,
      ),
    ).rejects.toThrow("Codex is not available for this specialist");
    await expect(prisma.bot.count({ where: { parentBotId: s.coordinator.id } })).resolves.toBe(
      before,
    );
  });

  it("closes once, archives through the shared core, and preserves the mission Computer", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Clean up after this work",
        requestedRights: {},
        spawnKey: `t08-close-${randomUUID()}`,
      },
      s.context,
    );
    const dedicated = await prisma.computer.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        scope: "dedicated",
        scopeKey: `t08-dedicated-scope-${randomUUID()}`,
        homeKey: `t08-dedicated-home-${randomUUID()}`,
        kind: "fake",
      },
    });
    await prisma.bot.update({ where: { id: receipt.botId }, data: { computerId: dedicated.id } });
    const routine = await prisma.routine.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        botId: receipt.botId,
        name: "T08 routine",
        prompt: "Never run",
        crons: ["0 * * * *"],
        active: true,
        nextRunAt: new Date(),
      },
    });

    await finishRuns(receipt.workId);
    await tasks.apply({ kind: "close", workId: receipt.workId }, s.context);
    await tasks.apply({ kind: "close", workId: receipt.workId }, s.context);

    await expect(
      prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId } }),
    ).resolves.toMatchObject({
      archivedAt: expect.any(Date),
    });
    await expect(
      prisma.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({
      active: false,
      nextRunAt: null,
    });
    await expect(
      prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } }),
    ).resolves.toMatchObject({
      status: "completed",
    });
    await expect(prisma.computer.findUnique({ where: { id: dedicated.id } })).resolves.toBeNull();
    await expect(
      prisma.computer.findUnique({ where: { id: s.missionComputer.id } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.lifecycleEvent.count({ where: { scopedTaskId: receipt.workId, kind: "work_closed" } }),
    ).resolves.toBe(1);
  });

  it("tells the coordinator thread each time its task tree changes", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const delegate = (name: string) =>
      tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name },
          harness: "codex-native",
          brief: "Change the tree",
          requestedRights: {},
          spawnKey: `tree-changed-${name}-${randomUUID()}`,
        },
        s.context,
      );
    const finished = await delegate("Finished");
    await finishRuns(finished.workId);
    await tasks.apply({ kind: "close", workId: finished.workId }, s.context);
    // A repeated close is not a second change.
    await tasks.apply({ kind: "close", workId: finished.workId }, s.context);
    const stopped = await delegate("Stopped");
    await tasks.apply(
      { kind: "cancel", workId: stopped.workId, reason: "No longer needed" },
      s.context,
    );

    const events = await prisma.event.findMany({
      where: { threadId: s.coordinatorThread.id, type: "work.tree_changed" },
      orderBy: { seq: "asc" },
    });
    // Each task: once created, once closed or cancelled.
    expect(events.map((event) => event.payload)).toEqual([
      { workId: finished.workId },
      { workId: finished.workId },
      { workId: stopped.workId },
      { workId: stopped.workId },
    ]);
    expect(s.deps.events.notify).toHaveBeenLastCalledWith(
      s.coordinatorThread.id,
      events.at(-1)!.seq,
    );
  });

  it("preserves a mission Computer when it is the specialist placement", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Use the shared mission Computer",
        requestedRights: {},
        spawnKey: `t08-placement-${randomUUID()}`,
      },
      s.context,
    );
    await prisma.bot.update({
      where: { id: receipt.botId },
      data: { computerId: s.missionComputer.id },
    });

    await finishRuns(receipt.workId);
    await tasks.apply({ kind: "close", workId: receipt.workId }, s.context);

    await expect(
      prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId } }),
    ).resolves.toMatchObject({
      archivedAt: expect.any(Date),
    });
    await expect(
      prisma.computer.findUnique({ where: { id: s.missionComputer.id } }),
    ).resolves.not.toBeNull();
  });

  it("reconciles a finished specialist's return that the worker never delivered, once", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Return after the worker died",
        requestedRights: {},
        spawnKey: `lost-return-${randomUUID()}`,
      },
      s.context,
    );
    // The worker finalized the specialist Run, then died before recordSpecialistResult.
    await prisma.$transaction((tx) =>
      createThreadMessageInTransaction(tx, {
        threadId: receipt.threadId,
        role: "bot",
        blocks: [{ kind: "text", text: "The audit found three issues." }],
        botId: receipt.botId,
        runId: receipt.runId!,
      }),
    );
    await prisma.run.update({ where: { id: receipt.runId! }, data: { status: "completed" } });
    const reconciler = createJobReconciler({
      prisma,
      jobs: s.deps.jobs,
      events: s.deps.events as never,
    });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    const returns = await prisma.message.findMany({
      where: { threadId: s.coordinatorThread.id, role: "bot" },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0]!.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "card",
          lines: expect.arrayContaining([
            { k: "workId", v: receipt.workId },
            { k: "outcome", v: "result" },
          ]),
        }),
        { kind: "text", text: "The audit found three issues." },
      ]),
    );
  });

  it("reconciles a specialist run cancelled alone as a cancelled return, but stays silent once the work is cancelled", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const delegate = (name: string) =>
      tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name },
          harness: "codex-native",
          brief: "Get stopped",
          requestedRights: {},
          spawnKey: `stopped-${name}-${randomUUID()}`,
        },
        s.context,
      );
    const stopped = await delegate("Stopped alone");
    const cancelledWork = await delegate("Cancelled with work");
    const lateAfterCancel = await delegate("Finished after cancel");
    const finishedThenClosed = await delegate("Finished then closed");
    await prisma.run.update({ where: { id: stopped.runId! }, data: { status: "cancelled" } });
    await tasks.apply(
      { kind: "cancel", workId: cancelledWork.workId, reason: "No longer needed" },
      s.context,
    );
    await tasks.apply(
      { kind: "cancel", workId: lateAfterCancel.workId, reason: "No longer needed" },
      s.context,
    );
    // The specialist still finished after its work was cancelled: a late trace, not a return.
    await prisma.run.update({
      where: { id: lateAfterCancel.runId! },
      data: { status: "completed" },
    });
    await prisma.run.update({
      where: { id: finishedThenClosed.runId! },
      data: { status: "completed" },
    });
    await tasks.apply({ kind: "close", workId: finishedThenClosed.workId }, s.context);

    await createJobReconciler({
      prisma,
      jobs: s.deps.jobs,
      events: s.deps.events as never,
    }).reconcileOnce();

    const cards = await prisma.message.findMany({
      where: { threadId: s.coordinatorThread.id, role: "bot" },
    });
    const returned = cards.map((card) => {
      const lines = (card.blocks as Array<{ lines?: Array<{ k: string; v: string }> }>)[0]!.lines!;
      return {
        workId: lines.find((line) => line.k === "workId")?.v,
        outcome: lines.find((line) => line.k === "outcome")?.v,
      };
    });
    expect(returned).toHaveLength(2);
    expect(returned).toEqual(
      expect.arrayContaining([
        { workId: stopped.workId, outcome: "cancelled" },
        // A closed work keeps receiving returns, as a passive receipt.
        { workId: finishedThenClosed.workId, outcome: "no_result" },
      ]),
    );
  });

  it("refuses to close a work while a descendant is open, then closes it once the descendant is closed", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const root = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Prepare the summary",
        requestedRights: {},
        spawnKey: `close-parent-${randomUUID()}`,
      },
      s.context,
    );
    const { receipt: child, context: childContext } = await delegateChild(
      s,
      root,
      `close-child-${randomUUID()}`,
    );

    await expect(tasks.apply({ kind: "close", workId: root.workId }, s.context)).rejects.toThrow(
      WorkHasOpenDescendantsError,
    );
    await expect(
      prisma.scopedTask.findUniqueOrThrow({ where: { id: child.workId } }),
    ).resolves.toMatchObject({ status: "dispatched" });
    await expect(
      prisma.scopedTask.findUniqueOrThrow({ where: { id: root.workId } }),
    ).resolves.toMatchObject({ status: "dispatched" });

    await finishRuns(child.workId);
    await tasks.apply({ kind: "close", workId: child.workId }, childContext);
    await finishRuns(root.workId);
    await tasks.apply({ kind: "close", workId: root.workId }, s.context);

    await expect(
      prisma.scopedTask.findUniqueOrThrow({ where: { id: root.workId } }),
    ).resolves.toMatchObject({ status: "closed" });
  });

  it("reconciles a confirmed native stop before terminal cleanup", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Recover terminal cleanup",
        requestedRights: {},
        spawnKey: `t08-reconcile-${randomUUID()}`,
      },
      s.context,
    );
    const providerComputer = await prisma.computer.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        scope: "dedicated",
        scopeKey: `t08-reconcile-scope-${randomUUID()}`,
        homeKey: `t08-reconcile-home-${randomUUID()}`,
        kind: "fake",
        providerRef: `fake-provider-${randomUUID()}`,
      },
    });
    await prisma.bot.update({
      where: { id: receipt.botId },
      data: { computerId: providerComputer.id },
    });
    await prisma.scopedTask.update({ where: { id: receipt.workId }, data: { status: "closed" } });
    await seedUnconfirmedNativeStop(receipt, providerComputer.id, "t08-reconfirmable-process");
    const sandbox = new FakeSandboxProvider() as FakeSandboxProvider &
      Pick<SandboxProvider, "reconfirmNativeProcess">;
    const reconfirm = vi.fn(async () => "stopped" as const);
    sandbox.reconfirmNativeProcess = reconfirm;

    await createJobReconciler({ prisma, jobs: s.deps.jobs, sandbox }).reconcileOnce();

    expect(reconfirm).toHaveBeenCalledOnce();
    await expect(
      prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId: receipt.botId, threadId: receipt.threadId } },
      }),
    ).resolves.toMatchObject({ processState: "stopped" });
    await expect(
      prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId } }),
    ).resolves.toMatchObject({
      archivedAt: expect.any(Date),
    });
  });

  it("leaves an unconfirmed native stop untouched when proof is absent", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Do not clean without proof",
        requestedRights: {},
        spawnKey: `t08-unconfirmed-${randomUUID()}`,
      },
      s.context,
    );
    const providerComputer = await prisma.computer.create({
      data: {
        spaceId: s.id,
        userId: s.id,
        scope: "dedicated",
        scopeKey: `t08-unconfirmed-scope-${randomUUID()}`,
        homeKey: `t08-unconfirmed-home-${randomUUID()}`,
        kind: "fake",
        providerRef: `fake-provider-${randomUUID()}`,
      },
    });
    await prisma.bot.update({
      where: { id: receipt.botId },
      data: { computerId: providerComputer.id },
    });
    await prisma.scopedTask.update({
      where: { id: receipt.workId },
      data: { status: "cancelled" },
    });
    await seedUnconfirmedNativeStop(receipt, providerComputer.id, "t08-still-running-process");
    const sandbox = new FakeSandboxProvider() as FakeSandboxProvider &
      Pick<SandboxProvider, "reconfirmNativeProcess">;
    const reconfirm = vi.fn(async () => "stop_unconfirmed" as const);
    sandbox.reconfirmNativeProcess = reconfirm;

    await createJobReconciler({ prisma, jobs: s.deps.jobs, sandbox }).reconcileOnce();

    expect(reconfirm).toHaveBeenCalledOnce();
    await expect(
      prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId: receipt.botId, threadId: receipt.threadId } },
      }),
    ).resolves.toMatchObject({ processState: "stop_unconfirmed" });
    await expect(
      prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId } }),
    ).resolves.toMatchObject({
      archivedAt: null,
    });

    await prisma.nativeSession.update({
      where: { botId_threadId: { botId: receipt.botId, threadId: receipt.threadId } },
      data: { processRef: null },
    });
    await createJobReconciler({ prisma, jobs: s.deps.jobs, sandbox }).reconcileOnce();
    expect(reconfirm).toHaveBeenCalledOnce();
    await expect(
      prisma.bot.findUniqueOrThrow({ where: { id: receipt.botId } }),
    ).resolves.toMatchObject({
      archivedAt: null,
    });
  });

  it("finding 7: two concurrent delegate calls on the same spawnKey never create two specialists", async () => {
    const s = await setup();
    const spawnKey = `spawn-concurrent-${randomUUID()}`;
    // A second real connection so the two calls race for the same DB unique constraints
    // (Bot.spaceId_spawnKey, ScopedTask.spaceId_spawnKey) rather than serializing on a
    // single client's connection.
    const db2 = createDb(process.env.DATABASE_URL!);
    const tasksA = createDelegatedTasks(s.deps);
    const tasksB = createDelegatedTasks({ prisma: db2.prisma, jobs: s.deps.jobs });
    const command = {
      kind: "delegate" as const,
      target: { kind: "from_profile" as const, profileBotId: s.profile.id, name: "Analyst" },
      harness: "codex-native" as const,
      brief: "Summarize the quarterly report",
      requestedRights: {},
      spawnKey,
    };
    try {
      const [receiptA, receiptB] = await Promise.all([
        tasksA.apply(command, s.context),
        tasksB.apply(command, s.context),
      ]);
      // Exactly one caller created the work identity; the other replayed it.
      expect([receiptA.replayed, receiptB.replayed].sort()).toEqual([false, true]);
      expect(receiptA.workId).toBe(receiptB.workId);
      expect(receiptA.botId).toBe(receiptB.botId);

      const specialists = await s.deps.prisma.bot.count({
        where: { parentBotId: s.coordinator.id },
      });
      expect(specialists).toBe(1);
      const scopedTasks = await s.deps.prisma.scopedTask.count({
        where: { spaceId: s.id, spawnKey },
      });
      expect(scopedTasks).toBe(1);
      // No orphan work thread left by the loser's rolled-back transaction.
      const workThreads = await s.deps.prisma.thread.count({
        where: { kind: "work", userId: s.id },
      });
      expect(workThreads).toBe(1);
    } finally {
      await db2.prisma.$disconnect();
      await db2.pool.end();
    }
  });

  it("lets only one of two parallel delegations take the last specialist slot", async () => {
    const s = await setup();
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", delegationMaxActiveSpecialists: 1 },
      update: { delegationMaxActiveSpecialists: 1 },
    });
    const db2 = createDb(process.env.DATABASE_URL!);
    // Both delegations read the count, then pause before writing: without a lock they would
    // each see a free slot.
    const pausingAfterCount = (client: PrismaClient) =>
      client.$extends({
        query: {
          scopedTask: {
            async count({ args, query }) {
              const count = await query(args);
              await sleep(300);
              return count;
            },
          },
        },
      }) as unknown as PrismaClient;
    const delegate = (spawnKey: string) => ({
      kind: "delegate" as const,
      target: { kind: "from_profile" as const, profileBotId: s.profile.id, name: "Analyst" },
      harness: "codex-native" as const,
      brief: "Summarize the quarterly report",
      requestedRights: {},
      spawnKey,
    });
    try {
      const outcomes = await Promise.allSettled([
        createDelegatedTasks({ ...s.deps, prisma: pausingAfterCount(prisma) }).apply(
          delegate(`spawn-slot-a-${randomUUID()}`),
          s.context,
        ),
        createDelegatedTasks({ prisma: pausingAfterCount(db2.prisma), jobs: s.deps.jobs }).apply(
          delegate(`spawn-slot-b-${randomUUID()}`),
          s.context,
        ),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
      const refused = outcomes.find((outcome) => outcome.status === "rejected");
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(DelegationLimitError);
      await expect(prisma.scopedTask.count({ where: { spaceId: s.id } })).resolves.toBe(1);
      // The refused delegation leaves no specialist bot without a mission.
      const missions = await prisma.scopedTask.findMany({
        where: { spaceId: s.id },
        select: { executorBotId: true },
      });
      const specialists = await prisma.bot.findMany({
        where: { parentBotId: s.coordinator.id },
        select: { id: true, archivedAt: true },
      });
      const idle = specialists.filter(
        (bot) => !missions.some((mission) => mission.executorBotId === bot.id),
      );
      expect(idle.every((bot) => bot.archivedAt !== null)).toBe(true);
      expect(specialists.filter((bot) => bot.archivedAt === null)).toHaveLength(1);
    } finally {
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { delegationMaxActiveSpecialists: null },
      });
      await db2.prisma.$disconnect();
      await db2.pool.end();
    }
  });

  it("keeps a persistent peer reply correlated with specialist work, then returns the work result", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Prepare the summary",
        requestedRights: {},
        spawnKey: `peer-${randomUUID()}`,
      },
      s.context,
    );
    const specialist = await prisma.bot.findUniqueOrThrow({
      where: { id: receipt.botId },
      include: { thread: true },
    });
    const peer = await prisma.bot.create({
      data: { spaceId: s.id, userId: s.id, name: "Peer", color: "test-color" },
    });
    const peerThread = await prisma.thread.create({
      data: { spaceId: s.id, userId: s.id, botId: peer.id },
    });
    await prisma.run.update({ where: { id: receipt.runId! }, data: { status: "running" } });
    const messageDeps = {
      prisma,
      jobs: s.deps.jobs,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
    };

    await messageBot(
      messageDeps as unknown as Parameters<typeof messageBot>[0],
      {
        id: receipt.runId!,
        spaceId: s.id,
        threadId: receipt.threadId,
        botId: specialist.id,
        userId: s.id,
      },
      { id: specialist.id, name: specialist.name },
      { bot_id: peer.id, message: "Can you verify the total?", intent: "question" },
    );
    const peerRun = await prisma.run.findFirstOrThrow({
      where: { botId: peer.id, threadId: peerThread.id, trigger: "bot_message" },
      orderBy: { createdAt: "desc" },
    });
    await prisma.run.update({ where: { id: peerRun.id }, data: { status: "running" } });

    await messageBot(
      messageDeps as unknown as Parameters<typeof messageBot>[0],
      {
        id: peerRun.id,
        spaceId: s.id,
        threadId: peerThread.id,
        botId: peer.id,
        userId: s.id,
        sourceMessageId: peerRun.sourceMessageId,
      },
      { id: peer.id, name: peer.name },
      { bot_id: specialist.id, message: "The total is verified.", intent: "result" },
    );
    const specialistReplyRun = await prisma.run.findFirstOrThrow({
      where: {
        botId: specialist.id,
        threadId: receipt.threadId,
        trigger: "bot_message",
        id: { not: receipt.runId! },
      },
      orderBy: { createdAt: "desc" },
      include: { sourceMessage: true },
    });

    expect(peerRun.scopedTaskId).toBeNull();
    expect(specialistReplyRun.scopedTaskId).toBe(receipt.workId);
    expect(specialistReplyRun.sourceMessage!.blocks as Array<{ kind: string }>).toEqual([
      expect.objectContaining({ kind: "bot_message_received", intent: "result" }),
    ]);
    await expect(prisma.scopedTask.count({ where: { spaceId: s.id } })).resolves.toBe(1);
    await expect(
      prisma.scopedTask.findUniqueOrThrow({ where: { id: receipt.workId } }),
    ).resolves.toMatchObject({ parentScopedTaskId: null });

    await recordSpecialistResult(s.deps, {
      workId: receipt.workId,
      runId: specialistReplyRun.id,
      text: "Summary complete.",
    });
    const returns = await prisma.message.findMany({
      where: { threadId: s.coordinatorThread.id, role: "bot" },
    });
    expect(returns).toHaveLength(1);
    expect(returns[0]!.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "card",
          lines: expect.arrayContaining([
            { k: "purpose", v: "work_return" },
            { k: "workId", v: receipt.workId },
          ]),
        }),
      ]),
    );
  });

  it("keeps a peer reply after cancellation out of the cancelled work and coordinator returns", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Prepare the summary",
        requestedRights: {},
        spawnKey: `cancelled-peer-${randomUUID()}`,
      },
      s.context,
    );
    const specialist = await prisma.bot.findUniqueOrThrow({
      where: { id: receipt.botId },
    });
    const peer = await prisma.bot.create({
      data: { spaceId: s.id, userId: s.id, name: "Peer", color: "test-color" },
    });
    const peerThread = await prisma.thread.create({
      data: { spaceId: s.id, userId: s.id, botId: peer.id },
    });
    const messageDeps = {
      prisma,
      jobs: s.deps.jobs,
      events: { notify: vi.fn().mockResolvedValue(undefined) },
    };
    await prisma.run.update({ where: { id: receipt.runId! }, data: { status: "running" } });

    await messageBot(
      messageDeps as unknown as Parameters<typeof messageBot>[0],
      {
        id: receipt.runId!,
        spaceId: s.id,
        threadId: receipt.threadId,
        botId: specialist.id,
        userId: s.id,
      },
      { id: specialist.id, name: specialist.name },
      { bot_id: peer.id, message: "Can you verify the total?", intent: "question" },
    );
    const peerRun = await prisma.run.findFirstOrThrow({
      where: { botId: peer.id, threadId: peerThread.id, trigger: "bot_message" },
      orderBy: { createdAt: "desc" },
    });
    await tasks.apply(
      { kind: "cancel", workId: receipt.workId, reason: "No longer needed" },
      s.context,
    );
    await prisma.run.update({ where: { id: peerRun.id }, data: { status: "running" } });

    await messageBot(
      messageDeps as unknown as Parameters<typeof messageBot>[0],
      {
        id: peerRun.id,
        spaceId: s.id,
        threadId: peerThread.id,
        botId: peer.id,
        userId: s.id,
        sourceMessageId: peerRun.sourceMessageId,
      },
      { id: peer.id, name: peer.name },
      { bot_id: specialist.id, message: "The total is verified.", intent: "result" },
    );
    const specialistReplyRun = await prisma.run.findFirst({
      where: {
        botId: specialist.id,
        threadId: receipt.threadId,
        trigger: "bot_message",
        id: { not: receipt.runId! },
      },
      orderBy: { createdAt: "desc" },
    });
    const passiveReceipt = await prisma.message.findFirstOrThrow({
      where: {
        threadId: receipt.threadId,
        replyToMessageId: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });

    expect(peerRun.scopedTaskId).toBeNull();
    expect(specialistReplyRun).toBeNull();
    expect(passiveReceipt.runId).toBeNull();
    expect(passiveReceipt.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received", intent: "result" }),
    ]);
    await expect(prisma.task.count({ where: { spaceId: s.id } })).resolves.toBe(3);
    await expect(prisma.run.count({ where: { spaceId: s.id } })).resolves.toBe(3);
    await expect(
      prisma.message.count({ where: { threadId: s.coordinatorThread.id, role: "bot" } }),
    ).resolves.toBe(0);
  });

  /**
   * T07: a specialist that itself holds an open scoped task (`root`) delegates further;
   * the child's parent/root/depth come only from `Run.scopedTaskId` of the calling run,
   * never a workId argument. Returns both the parent receipt and the child's own
   * coordinator context, so a caller can keep delegating one level deeper.
   */
  async function delegateChild(
    s: Awaited<ReturnType<typeof setup>>,
    parentReceipt: { botId: string; runId?: string },
    spawnKey: string,
  ) {
    const tasks = createDelegatedTasks(s.deps);
    const actor: AuthorizedActor = {
      userId: s.id,
      spaceId: s.id,
      botId: parentReceipt.botId,
      rights: {},
    };
    const context: CommandContext = {
      actor,
      originRunId: parentReceipt.runId!,
      requestId: randomUUID(),
    };
    const receipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Sub-analyst" },
        harness: "codex-native",
        brief: "Dig into one section",
        requestedRights: {},
        spawnKey,
      },
      context,
    );
    return { receipt, actor, context };
  }

  it("T07 task 1: wires a specialist's further delegation one depth deeper", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const rootReceipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Prepare the summary",
        requestedRights: {},
        spawnKey: `t07-root-${randomUUID()}`,
      },
      s.context,
    );

    const { receipt: childReceipt, actor: childActor } = await delegateChild(
      s,
      rootReceipt,
      `t07-child-${randomUUID()}`,
    );

    const childTree = await tasks.inspect(childReceipt.workId, childActor);
    expect(childTree.root.parentScopedTaskId).toBe(rootReceipt.workId);
    expect(childTree.root.rootScopedTaskId).toBe(rootReceipt.workId);
    expect(childTree.root.depth).toBe(1);

    // An ordinary coordinator's own delegation, unaffected by this lot (non-regression).
    const rootTree = await tasks.inspect(rootReceipt.workId, s.actor);
    expect(rootTree.root.parentScopedTaskId).toBeNull();
    expect(rootTree.root.depth).toBe(0);
  });

  it(
    "T07 rouge1/vert1 + scenario 2 (b: child created, then root cancelled): cascades to the " +
      "descendant and its Run, revokes its grant, leaves a lateral peer intact",
    async () => {
      const s = await setup();
      const tasks = createDelegatedTasks(s.deps);
      const rootReceipt = await tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
          harness: "codex-native",
          brief: "Prepare the summary",
          requestedRights: {},
          spawnKey: `t07-cascade-root-${randomUUID()}`,
        },
        s.context,
      );
      // A lateral peer under the *same* coordinator, a sibling tree — must survive.
      const peerReceipt = await tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name: "Peer analyst" },
          harness: "codex-native",
          brief: "Unrelated work",
          requestedRights: {},
          spawnKey: `t07-cascade-peer-${randomUUID()}`,
        },
        s.context,
      );

      // (b) commit order: the child is created and fully committed *before* cancellation.
      const { receipt: childReceipt, actor: childActor } = await delegateChild(
        s,
        rootReceipt,
        `t07-cascade-child-${randomUUID()}`,
      );

      await tasks.apply(
        { kind: "cancel", workId: rootReceipt.workId, reason: "No longer needed" },
        s.context,
      );

      const rootTree = await tasks.inspect(rootReceipt.workId, s.actor);
      expect(rootTree.root.status).toBe("cancelled");
      const childTree = await tasks.inspect(childReceipt.workId, childActor);
      expect(childTree.root.status).toBe("cancelled");
      const peerTree = await tasks.inspect(peerReceipt.workId, s.actor);
      expect(peerTree.root.status).not.toBe("cancelled");

      const rootRun = await prisma.run.findUniqueOrThrow({ where: { id: rootReceipt.runId! } });
      expect(rootRun.status).toBe("cancelled");
      const childRun = await prisma.run.findUniqueOrThrow({ where: { id: childReceipt.runId! } });
      expect(childRun.status).toBe("cancelled");
      const peerRun = await prisma.run.findUniqueOrThrow({ where: { id: peerReceipt.runId! } });
      expect(peerRun.status).not.toBe("cancelled");

      await expect(
        prisma.computerUsageGrant.findUnique({
          where: {
            computerId_botId: { computerId: s.missionComputer.id, botId: rootReceipt.botId },
          },
        }),
      ).resolves.toBeNull();
      await expect(
        prisma.computerUsageGrant.findUnique({
          where: {
            computerId_botId: { computerId: s.missionComputer.id, botId: childReceipt.botId },
          },
        }),
      ).resolves.toBeNull();
      await expect(
        prisma.computerUsageGrant.findUnique({
          where: {
            computerId_botId: { computerId: s.missionComputer.id, botId: peerReceipt.botId },
          },
        }),
      ).resolves.not.toBeNull();
    },
  );

  // REVIEW T07: an already-closed intermediary is still a structural link in the tree.
  // This intentionally exposes whether cancellation reaches its active descendant.
  it("REVIEW T07: cancellation crosses a closed intermediary to its active descendant", async () => {
    const s = await setup();
    const tasks = createDelegatedTasks(s.deps);
    const rootReceipt = await tasks.apply(
      {
        kind: "delegate",
        target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
        harness: "codex-native",
        brief: "Prepare the summary",
        requestedRights: {},
        spawnKey: `t07-review-closed-link-root-${randomUUID()}`,
      },
      s.context,
    );
    const { receipt: childReceipt } = await delegateChild(
      s,
      rootReceipt,
      `t07-review-closed-link-child-${randomUUID()}`,
    );
    const { receipt: grandchildReceipt, actor: grandchildActor } = await delegateChild(
      s,
      childReceipt,
      `t07-review-closed-link-grandchild-${randomUUID()}`,
    );

    // Closing with an open descendant is now refused; a link closed before that rule still
    // has to be crossed.
    await prisma.scopedTask.update({
      where: { id: childReceipt.workId },
      data: { status: "closed" },
    });
    await tasks.apply(
      { kind: "cancel", workId: rootReceipt.workId, reason: "No longer needed" },
      s.context,
    );

    const grandchildTree = await tasks.inspect(grandchildReceipt.workId, grandchildActor);
    const grandchildRun = await prisma.run.findUniqueOrThrow({
      where: { id: grandchildReceipt.runId! },
    });
    expect({ work: grandchildTree.root.status, run: grandchildRun.status }).toEqual({
      work: "cancelled",
      run: "cancelled",
    });
  });

  it(
    "T07 scenario 2 (a: root cancelled and fully committed, then a child spawn is attempted): " +
      "refused, no orphan active work",
    async () => {
      const s = await setup();
      const tasks = createDelegatedTasks(s.deps);
      const rootReceipt = await tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
          harness: "codex-native",
          brief: "Prepare the summary",
          requestedRights: {},
          spawnKey: `t07-refuse-root-${randomUUID()}`,
        },
        s.context,
      );

      await tasks.apply(
        { kind: "cancel", workId: rootReceipt.workId, reason: "No longer needed" },
        s.context,
      );

      const spawnKey = `t07-refuse-child-${randomUUID()}`;
      await expect(delegateChild(s, rootReceipt, spawnKey)).rejects.toBeInstanceOf(WorkClosedError);

      // No scoped_tasks row and no orphan active specialist bot for the refused attempt.
      await expect(
        prisma.scopedTask.findUnique({
          where: { spaceId_spawnKey: { spaceId: s.id, spawnKey } },
        }),
      ).resolves.toBeNull();
      await expect(prisma.bot.count({ where: { parentBotId: rootReceipt.botId } })).resolves.toBe(
        0,
      );
    },
  );

  it(
    "T07 scenario 2 race: a real concurrent spawn and cancel on the same parent never leave " +
      "an active child under a cancelled root, whichever one commits first",
    async () => {
      const s = await setup();
      const tasks = createDelegatedTasks(s.deps);
      const rootReceipt = await tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
          harness: "codex-native",
          brief: "Prepare the summary",
          requestedRights: {},
          spawnKey: `t07-race-root-${randomUUID()}`,
        },
        s.context,
      );

      // A second real connection: the cancel's row lock and the child spawn's `SELECT ...
      // FOR UPDATE` on the *same* scoped_tasks row must be a genuine Postgres lock wait,
      // not in-process serialization on a single client.
      const db2 = createDb(process.env.DATABASE_URL!);
      const spawnKey = `t07-race-child-${randomUUID()}`;
      const childActor: AuthorizedActor = {
        userId: s.id,
        spaceId: s.id,
        botId: rootReceipt.botId,
        rights: {},
      };
      const childContext: CommandContext = {
        actor: childActor,
        originRunId: rootReceipt.runId!,
        requestId: randomUUID(),
      };
      const tasksSpawn = createDelegatedTasks({ prisma: db2.prisma, jobs: s.deps.jobs });
      try {
        const [spawnResult, cancelReceipt] = await Promise.all([
          tasksSpawn
            .apply(
              {
                kind: "delegate",
                target: { kind: "from_profile", profileBotId: s.profile.id, name: "Sub-analyst" },
                harness: "codex-native",
                brief: "Dig into one section",
                requestedRights: {},
                spawnKey,
              },
              childContext,
            )
            .then((receipt) => ({ refused: false as const, receipt }))
            .catch((error) => ({ refused: true as const, error })),
          tasks.apply(
            { kind: "cancel", workId: rootReceipt.workId, reason: "No longer needed" },
            s.context,
          ),
        ]);
        expect(cancelReceipt.state).toBe("cancelling");

        const rootTree = await tasks.inspect(rootReceipt.workId, s.actor);
        expect(rootTree.root.status).toBe("cancelled");

        if (spawnResult.refused) {
          // Commit order (a): the cancel's row lock won, the spawn observed the
          // already-cancelled parent and was refused outright.
          expect(spawnResult.error).toBeInstanceOf(WorkClosedError);
          await expect(
            prisma.scopedTask.findUnique({
              where: { spaceId_spawnKey: { spaceId: s.id, spawnKey } },
            }),
          ).resolves.toBeNull();
          // ... and the specialist bot it had already created does not outlive the refusal.
          const childBots = await prisma.bot.findMany({
            where: { parentBotId: rootReceipt.botId },
            select: { archivedAt: true },
          });
          expect(childBots.every((bot) => bot.archivedAt !== null)).toBe(true);
        } else {
          // Commit order (b): the spawn's row lock won and its child committed first;
          // the cancel's cascade, walking `parentScopedTaskId` after that commit, still
          // reached and cancelled it — no active child survives under the cancelled root.
          const childTree = await tasks.inspect(spawnResult.receipt.workId, childActor);
          expect(childTree.root.status).toBe("cancelled");
          const childRun = await prisma.run.findUniqueOrThrow({
            where: { id: spawnResult.receipt.runId! },
          });
          expect(childRun.status).toBe("cancelled");
        }
      } finally {
        await db2.prisma.$disconnect();
        await db2.pool.end();
      }
    },
  );

  it(
    "T07:3 residual of B1: a close committing between the cascade's read and its guarded " +
      "write is never stomped, its active sub-tree is still reached and cancelled",
    async () => {
      const s = await setup();
      const tasks = createDelegatedTasks(s.deps);
      const rootReceipt = await tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: s.profile.id, name: "Analyst" },
          harness: "codex-native",
          brief: "Prepare the summary",
          requestedRights: {},
          spawnKey: `t073-root-${randomUUID()}`,
        },
        s.context,
      );
      const { receipt: childReceipt, actor: childAsCoordinatorActor } = await delegateChild(
        s,
        rootReceipt,
        `t073-child-${randomUUID()}`,
      );
      const { receipt: grandchildReceipt, actor: grandchildAsCoordinatorActor } =
        await delegateChild(s, childReceipt, `t073-grandchild-${randomUUID()}`);

      // A second real connection: it holds the row lock on the child's scoped_tasks
      // row for as long as we need to prove the cascade's own guarded write actually
      // blocks on it — a genuine Postgres lock, not in-process serialization.
      const db2 = createDb(process.env.DATABASE_URL!);
      const order: string[] = [];
      let releaseClose: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });

      const closePromise = db2.prisma.$transaction(async (tx2) => {
        await tx2.$queryRaw`SELECT id FROM scoped_tasks WHERE id = ${childReceipt.workId} FOR UPDATE`;
        order.push("close:locked");
        await barrier;
        // Sets the row directly to "closed" while still holding its lock — standing in
        // for any authorized path that closes this exact task at this exact instant
        // (e.g. delegate_close), which is all this residual cares about: what the
        // cascade does when it discovers the row already closed at write time.
        await tx2.scopedTask.update({
          where: { id: childReceipt.workId },
          data: { status: "closed" },
        });
        order.push("close:done");
      });

      // Wait until the lock is actually taken (bounded poll, no fixed sleep before the
      // condition we assert on).
      const lockDeadline = Date.now() + 5_000;
      while (!order.includes("close:locked")) {
        if (Date.now() > lockDeadline)
          throw new Error("close transaction never reached its row lock");
        await sleep(5);
      }

      const cancelPromise = tasks
        .apply(
          { kind: "cancel", workId: rootReceipt.workId, reason: "No longer needed" },
          s.context,
        )
        .then((receipt) => {
          order.push("cancel:done");
          return receipt;
        });

      // Deterministic oracle: poll pg_stat_activity until the cascade's own guarded
      // UPDATE on scoped_tasks is observed actually waiting on the row lock — proof the
      // write reached Postgres and blocked on the exact row the close transaction
      // holds, not a fixed delay that could elapse before it even arrives under a slow
      // scheduler. Bounded, not a sleep-as-oracle: a removed guard/lock never blocks,
      // so the wait either times out or `cancel:done` appears first — both fail the
      // assertions below.
      const lockWaitDeadline = Date.now() + 3_000;
      let observedLockWait = false;
      while (Date.now() < lockWaitDeadline) {
        if (order.includes("cancel:done")) break;
        const waiting = await prisma.$queryRaw<Array<{ found: boolean }>>`
          select exists (
            select 1 from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike '%update%scoped_tasks%'
              and state = 'active'
          ) as found`;
        if (waiting[0]?.found) {
          observedLockWait = true;
          break;
        }
        await sleep(5);
      }
      expect(observedLockWait).toBe(true);
      expect(order).toEqual(["close:locked"]);

      releaseClose();
      try {
        const [, cancelReceipt] = await Promise.all([closePromise, cancelPromise]);
        expect(cancelReceipt.state).toBe("cancelling");

        // The concurrently-closed child keeps exactly the status the concurrent close
        // gave it — never stomped back to "cancelled" by the cascade's guarded write.
        const childTree = await tasks.inspect(childReceipt.workId, childAsCoordinatorActor);
        expect(childTree.root.status).toBe("closed");
        const childRun = await prisma.run.findUniqueOrThrow({ where: { id: childReceipt.runId! } });
        expect(childRun.status).not.toBe("cancelled");

        // Its own active grandchild is still reached and cancelled: the traversal does
        // not depend on whether the child itself was claimed.
        const grandchildTree = await tasks.inspect(
          grandchildReceipt.workId,
          grandchildAsCoordinatorActor,
        );
        expect(grandchildTree.root.status).toBe("cancelled");
        const grandchildRun = await prisma.run.findUniqueOrThrow({
          where: { id: grandchildReceipt.runId! },
        });
        expect(grandchildRun.status).toBe("cancelled");
      } finally {
        await db2.prisma.$disconnect();
        await db2.pool.end();
      }
    },
  );
});
