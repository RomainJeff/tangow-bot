import type { AdapterContext } from "@rakazo/adapter-kit";
import type { RunNeeds, WorkerLaunch } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { createWorkerLifecycle } from "./worker-lifecycle.js";

export const mcpOnly: RunNeeds = { files: { private: null, shared: null }, computer: "none" };
export const allFiles: RunNeeds = { files: { private: "rw", shared: "rw" }, computer: "on_use" };

/** Seeds spaces, computers, bots, runs, attempts and volumes under ids unique to this fixture. */
export function workerFixture(prisma: PrismaClient) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const userId = `user_${stamp}`;
  const organizationId = `org_${stamp}`;
  let sequence = 0;
  const unique = (prefix: string) => `${prefix}_${stamp}_${++sequence}`;

  const fixture = {
    unique,
    userId,
    context: {
      operationId: "worker-test",
      traceId: "worker-test",
      spaceId: "worker-test",
      userId,
      signal: new AbortController().signal,
    } satisfies AdapterContext,

    async seedOwner() {
      await prisma.user.create({
        data: { id: userId, name: "W", email: `${userId}@rakazo.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "W", slug: organizationId, createdAt: new Date() },
      });
    },

    async seedSpace() {
      const id = unique("space");
      await prisma.space.create({ data: { id, organizationId, name: id } });
      return id;
    },

    async seedComputer(
      spaceId: string,
      fields: { kind?: string; scope?: string; homeStorage?: string } = {},
    ) {
      const key = unique("home");
      return await prisma.computer.create({
        data: { spaceId, userId, scopeKey: key, homeKey: key, kind: "e2b", ...fields },
      });
    },

    async seedBot(spaceId: string, computerId: string | null) {
      const bot = await prisma.bot.create({
        data: { spaceId, userId, name: unique("bot"), color: "#00C46A", computerId },
      });
      const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
      return { ...bot, threadId: thread.id };
    },

    async seedRun(
      bot: { id: string; spaceId: string; threadId: string },
      fields: { leaseFence?: number; status?: string; leaseExpiresAt?: Date } = {},
    ) {
      const task = await prisma.task.create({
        data: {
          spaceId: bot.spaceId,
          botId: bot.id,
          threadId: bot.threadId,
          userId,
          prompt: "",
          status: "running",
        },
      });
      return await prisma.run.create({
        data: {
          spaceId: bot.spaceId,
          botId: bot.id,
          threadId: bot.threadId,
          taskId: task.id,
          userId,
          status: "running",
          trigger: "user",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          ...fields,
        },
      });
    },

    async seedAttempt(runId: string, fence = 1, worker: Record<string, unknown> = {}) {
      return await prisma.attempt.create({ data: { runId, fence, status: "running", ...worker } });
    },

    async seedVolume(
      kind: "bot_private" | "space_shared",
      spaceId: string,
      botId: string | null,
      providerRef: string | null = unique("fake-volume"),
    ) {
      return await prisma.volume.create({
        data: { kind, spaceId, botId, providerKind: "fake-worker", providerRef },
      });
    },

    /** A space whose team computer already moved to volumes, one bot on it, and both volumes. */
    async migratedBot() {
      const spaceId = await fixture.seedSpace();
      const computer = await fixture.seedComputer(spaceId, { homeStorage: "volumes" });
      const bot = await fixture.seedBot(spaceId, computer.id);
      const privateVolume = await fixture.seedVolume("bot_private", spaceId, bot.id);
      const sharedVolume = await fixture.seedVolume("space_shared", spaceId, null);
      return { computer, bot, privateVolume, sharedVolume };
    },

    async launchFor(
      workers: ReturnType<typeof createWorkerLifecycle>,
      attemptId: string,
      needs: RunNeeds,
    ): Promise<WorkerLaunch> {
      const plan = await workers.plan({ attemptId, needs });
      if (plan.mode !== "worker") throw new Error(`expected a worker plan, got ${plan.reason}`);
      return plan;
    },

    async writerOf(volumeId: string) {
      return (await prisma.volume.findUniqueOrThrow({ where: { id: volumeId } })).writerAttemptId;
    },

    async workerStateOf(attemptId: string) {
      return (await prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } })).workerState;
    },
  };
  return fixture;
}
