import type { AdapterContext } from "@tangow/adapter-kit";
import type { RunNeeds, WorkerLaunch } from "@tangow/core";
import { WORKER_ENSURE_TIMEOUT_SECONDS } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import type { createWorkerLifecycle } from "./worker-lifecycle.js";

export const mcpOnly: RunNeeds = { files: { private: null, shared: null }, computer: "none" };
export const allFiles: RunNeeds = { files: { private: "rw", shared: "rw" }, computer: "on_use" };
export const privateFiles: RunNeeds = { files: { private: "rw", shared: null }, computer: "none" };
/** An ensure start from before the ensure timeout, so an absent VM counts as never created. */
export const pastEnsureTimeout = () =>
  new Date(Date.now() - (WORKER_ENSURE_TIMEOUT_SECONDS + 60) * 1000);

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
        data: { id: userId, name: "W", email: `${userId}@tangow.test` },
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

    async seedMembership(spaceId: string) {
      const createdAt = new Date();
      const role = "owner";
      await prisma.member.upsert({
        where: { organizationId_userId: { organizationId, userId } },
        create: { id: unique("member"), organizationId, userId, role, createdAt },
        update: {},
      });
      await prisma.spaceMember.create({
        data: { id: unique("space_member"), spaceId, organizationId, userId, role, createdAt },
      });
    },

    async seedComputer(
      spaceId: string,
      fields: { kind?: string; scope?: string; homeStorage?: string; userId?: string } = {},
    ) {
      const key = unique("home");
      return await prisma.computer.create({
        data: { spaceId, userId, scopeKey: key, homeKey: key, kind: "e2b", ...fields },
      });
    },

    async seedBot(spaceId: string, computerId: string | null, owner = userId) {
      const bot = await prisma.bot.create({
        data: { spaceId, userId: owner, name: unique("bot"), color: "#00C46A", computerId },
      });
      const thread = await prisma.thread.create({
        data: { spaceId, userId: owner, botId: bot.id },
      });
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
      owner = userId,
    ) {
      return await prisma.volume.create({
        data: {
          kind,
          spaceId,
          botId,
          userId: kind === "space_shared" ? owner : null,
          providerKind: "fake-worker",
          providerRef,
        },
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

    /** A second bot on the same migrated computer, with its own private volume. */
    async teammateOf(computer: { id: string; spaceId: string }) {
      const bot = await fixture.seedBot(computer.spaceId, computer.id);
      const privateVolume = await fixture.seedVolume("bot_private", computer.spaceId, bot.id);
      return { bot, privateVolume };
    },

    async launchFor(
      workers: ReturnType<typeof createWorkerLifecycle>,
      attemptId: string,
      needs: RunNeeds,
    ): Promise<WorkerLaunch> {
      const plan = await workers.plan({ attemptId, needs });
      if (plan.mode !== "worker")
        throw new Error(`expected a worker plan, got ${JSON.stringify(plan)}`);
      return plan;
    },

    async workerStateOf(attemptId: string) {
      return (await prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } })).workerState;
    },

    /** Lets the ensure timeout of a worker pass. */
    async outliveEnsure(attemptId: string) {
      await prisma.attempt.update({
        where: { id: attemptId },
        data: { workerEnsureAt: pastEnsureTimeout() },
      });
    },
  };
  return fixture;
}
