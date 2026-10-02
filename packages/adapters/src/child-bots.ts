import { rm } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { routineJobKey, runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import type { NativeHarnessChoice } from "@rakazo/contracts";
import {
  type Actor,
  type Bot,
  type ComputerMode,
  GROUP_MEMBER_MIN,
  NATIVE_HARNESSES,
  WORK_TERMINAL_STATUSES,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  cancelRunsInTransaction,
  computerScopeKey,
  createRepos,
  createThreadMessageInTransaction,
  expireComputerExecutionLeases,
  type Prisma,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ProfileConnectionThinkingResolver, ProfileModelSelection } from "./bot-profiles.js";
import { applyBotProfile, loadBotProfile } from "./bot-profiles.js";
import { toComputerRef } from "./computer-support.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import { resolveAgentHomePath } from "./home.js";
import { removePiBotSessions } from "./pi-session.js";

async function cancelCoordinatorScopedTasks(
  tx: Prisma.TransactionClient,
  coordinatorBotId: string,
) {
  const openWork = await tx.scopedTask.findMany({
    where: {
      coordinatorBotId,
      status: { notIn: [...WORK_TERMINAL_STATUSES] },
    },
    select: { id: true, missionComputerId: true, executorBotId: true },
  });
  const activeRuns = openWork.length
    ? await tx.run.findMany({
        where: {
          scopedTaskId: { in: openWork.map((work) => work.id) },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true, taskId: true },
      })
    : [];
  await tx.scopedTask.updateMany({
    where: { coordinatorBotId, status: { notIn: [...WORK_TERMINAL_STATUSES] } },
    data: { status: "cancelled" },
  });
  await cancelRunsInTransaction(tx, activeRuns, new Date());
  for (const work of openWork) {
    if (!work.missionComputerId) continue;
    const remaining = await tx.scopedTask.count({
      where: {
        missionComputerId: work.missionComputerId,
        executorBotId: work.executorBotId,
        status: { notIn: [...WORK_TERMINAL_STATUSES] },
      },
    });
    if (remaining !== 0) continue;
    await tx.computerUsageGrant.deleteMany({
      where: { computerId: work.missionComputerId, botId: work.executorBotId },
    });
  }
}

export function confirmSpawnedBotName(confirmName: string, botName: string) {
  if (confirmName !== botName) {
    return {
      ok: false as const,
      error: "confirm_name must exactly match the bot's name. Refusing to archive.",
    };
  }
  return { ok: true as const };
}

export function composeChildInstructions(
  profileInstructions: string,
  missionInstructions?: string,
) {
  const profile = profileInstructions.trim();
  const mission = (missionInstructions ?? "").trim();
  return [profile, mission].filter(Boolean).join("\n\n");
}

export async function spawnBot(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    deploymentModelKey?: string;
    resolveConnectionThinkingLevel?: ProfileConnectionThinkingResolver;
    coordinatorModel?: ProfileModelSelection;
  },
  input: {
    spawnedBy: {
      id: string;
      name: string;
      spaceId: string;
      userId: string;
    };
    runId: string;
    spawnKey: string;
    name: string;
    title?: string;
    instructions?: string;
    prompt?: string;
    computerMode?: ComputerMode;
    profileBotId?: string;
    harness?: NativeHarnessChoice;
  },
) {
  const name = input.name.trim();
  if (!name) return { error: "Bot name is required." };

  const actor: Actor = {
    userId: input.spawnedBy.userId,
    spaceId: input.spawnedBy.spaceId,
    email: "",
    isDeploymentOwner: false,
  };
  const profileScope = { userId: actor.userId, spaceId: actor.spaceId };
  const profile = input.profileBotId
    ? await loadBotProfile(deps.prisma, profileScope, input.profileBotId, {
        deployment: deps.deploymentModelKey ? resolveDeploymentModel() : null,
        resolveConnectionThinkingLevel: deps.resolveConnectionThinkingLevel,
        inheritFrom: { botId: input.spawnedBy.id, model: deps.coordinatorModel },
      })
    : undefined;
  if (
    profile &&
    input.harness &&
    profile.modelProvider !== NATIVE_HARNESSES[input.harness].provider
  ) {
    throw new Error(
      `A ${NATIVE_HARNESSES[input.harness].name} native specialist needs a model on its subscription; the selected model is ${profile.modelProvider} · ${profile.modelId}.`,
    );
  }
  const instructions = profile
    ? composeChildInstructions(profile.instructions, input.instructions)
    : (input.instructions ?? "").trim();
  let duplicate = false;
  let created: Pick<Bot, "id" | "name" | "title" | "threadId">;
  try {
    created = await createRepos(deps.prisma).createBot(actor, {
      name,
      title: (input.title ?? "").trim(),
      description: "",
      instructions,
      notifyOnFinish: profile?.notifyOnFinish ?? true,
      parentBotId: input.spawnedBy.id,
      spawnKey: input.spawnKey,
      computerMode: input.computerMode,
      ...(profile
        ? {
            modelProvider: profile.modelProvider,
            modelId: profile.modelId,
            thinkingLevel: profile.thinkingLevel,
          }
        : {}),
      initialMessage: {
        role: "system",
        blocks: [{ kind: "meta", text: `Created by ${input.spawnedBy.name}` }],
        runId: input.runId,
      },
    });
  } catch (error) {
    const existing = await deps.prisma.bot.findUnique({
      where: {
        spaceId_spawnKey: {
          spaceId: input.spawnedBy.spaceId,
          spawnKey: input.spawnKey,
        },
      },
      include: { thread: true },
    });
    if (!existing) throw error;
    if (!existing.thread) throw new Error(`Spawned bot ${existing.id} is missing its thread`);
    duplicate = true;
    created = {
      id: existing.id,
      name: existing.name,
      title: existing.title,
      threadId: existing.thread.id,
    };
  }

  if (profile) await applyBotProfile(deps.prisma, profileScope, created.id, profile);

  const prompt = (input.prompt ?? "").trim();
  if (prompt) {
    const run = await ensureSpawnRun(deps.prisma, {
      spaceId: input.spawnedBy.spaceId,
      userId: input.spawnedBy.userId,
      botId: created.id,
      threadId: created.threadId,
      sourceRunId: input.runId,
      spawnKey: input.spawnKey,
      prompt,
    });
    await deps.jobs
      .enqueue(runContinueJob(run.id))
      .catch((error) => getLogger().error("spawned bot enqueue", error));
  }

  return {
    ok: true as const,
    ...(duplicate ? { duplicate: true as const } : {}),
    botId: created.id,
    name: created.name,
    title: created.title,
    threadId: created.threadId,
  };
}

async function ensureSpawnRun(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    sourceRunId: string;
    spawnKey: string;
    prompt: string;
  },
) {
  const clientNonce = `spawn:${input.spawnKey}`;
  const where = {
    spaceId_clientNonce: {
      spaceId: input.spaceId,
      clientNonce,
    },
  } as const;
  const existing = await prisma.run.findUnique({ where });
  if (existing) return existing;

  try {
    return await prisma.$transaction(async (tx) => {
      await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: [{ kind: "text", text: input.prompt }],
        runId: input.sourceRunId,
      });
      const task = await tx.task.create({
        data: {
          spaceId: input.spaceId,
          botId: input.botId,
          threadId: input.threadId,
          userId: input.userId,
          prompt: input.prompt,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          spaceId: input.spaceId,
          botId: input.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: input.userId,
          status: "queued",
          trigger: "spawn",
          clientNonce,
        },
      });
    });
  } catch (error) {
    const winner = await prisma.run.findUnique({ where });
    if (winner) return winner;
    throw error;
  }
}

type BotLifecycleDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  dataDir?: string;
  artifacts?: ArtifactStore;
};

type LifecycleBot = {
  id: string;
  spaceId: string;
  name: string;
  userId?: string;
  archivedAt: Date | null;
  computerId?: string | null;
  webhookSecretId?: string | null;
};

/** The transactional part of archival is shared by explicit archival and T08 cleanup. */
export async function archiveBotInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    bot: LifecycleBot;
    dedicatedComputerId?: string;
    activeRuns: Array<{ id: string }>;
    now: Date;
  },
) {
  const runIds = input.activeRuns.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: input.now },
  });
  await tx.task.updateMany({
    where: { runs: { some: { id: { in: runIds } } } },
    data: { status: "cancelled" },
  });
  await tx.routine.updateMany({
    where: { botId: input.bot.id },
    data: { active: false, nextRunAt: null },
  });
  await cancelCoordinatorScopedTasks(tx, input.bot.id);
  await expireComputerExecutionLeases(tx, { botId: input.bot.id });
  await tx.computer.updateMany({
    where: { OR: [{ controlBotId: input.bot.id }, { executionBotId: input.bot.id }] },
    data: releasedComputerLease(),
  });
  if (input.dedicatedComputerId) {
    await tx.computer.updateMany({
      where: { id: input.dedicatedComputerId, state: { not: "running" } },
      data: { state: "stopped" },
    });
  }
  await tx.bot.update({
    where: { id: input.bot.id },
    data: { archivedAt: input.bot.archivedAt ?? input.now, pinned: false },
  });
}

export async function archiveSpawnedBot(
  deps: BotLifecycleDeps,
  input: {
    spawnedByBotId: string;
    userId: string;
    spaceId: string;
    confirmName: string;
    botId?: string;
  },
  context: AdapterContext,
) {
  const confirmName = input.confirmName.trim();
  if (!confirmName) {
    return { error: "confirm_name is required. Refusing to archive." };
  }

  const spawned = await deps.prisma.bot.findMany({
    where: {
      parentBotId: input.spawnedByBotId,
      userId: input.userId,
      spaceId: input.spaceId,
    },
  });
  const matches = input.botId
    ? spawned.filter((bot) => bot.id === input.botId)
    : spawned.filter((bot) => bot.name === confirmName);

  if (input.botId && matches.length === 0) {
    return { error: "That bot was not created by this bot. Refusing to archive." };
  }
  if (!input.botId && matches.length === 0) {
    return { error: `This bot did not create a bot named "${confirmName}". Refusing to archive.` };
  }
  if (!input.botId && matches.length > 1) {
    return {
      error: `More than one bot is named "${confirmName}". Pass bot_id as well as confirm_name.`,
    };
  }

  const target = matches[0]!;
  const confirmed = confirmSpawnedBotName(confirmName, target.name);
  if (!confirmed.ok) return confirmed;
  if (target.id === input.spawnedByBotId) {
    return { error: "A bot cannot archive itself with archive_bot." };
  }

  await archiveBot(deps, target, context);
  return { ok: true as const, botId: target.id, name: target.name };
}

export async function archiveBot(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
) {
  const [dedicated, activeRuns, activeRoutines] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { scopeKey: computerScopeKey("dedicated", bot.spaceId, bot.id) },
    }),
    deps.prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
    deps.prisma.routine.findMany({
      where: { botId: bot.id, active: true },
      select: { id: true },
    }),
  ]);
  const now = new Date();
  await deps.prisma.$transaction(async (tx) => {
    await archiveBotInTransaction(tx, {
      bot,
      dedicatedComputerId: dedicated?.id,
      activeRuns,
      now,
    });
  });
  await Promise.allSettled([
    ...activeRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
    ...activeRoutines.map((routine) => deps.jobs.cancel(routineJobKey(routine.id))),
  ]);
  await releaseTeamComputerScreen(deps, bot, dedicated?.id, context);
  const currentDedicated = dedicated
    ? await deps.prisma.computer.findUnique({ where: { id: dedicated.id } })
    : null;
  if (currentDedicated?.providerRef && currentDedicated.state === "running") {
    const ref = toComputerRef(currentDedicated);
    await checkpointAndRecordComputerWorkspace(deps, currentDedicated, ref, context);
    await deps.sandbox.stop(ref, context);
    await deps.prisma.computer.updateMany({
      where: {
        id: currentDedicated.id,
        state: "running",
        providerRef: currentDedicated.providerRef,
      },
      data: { state: "stopped" },
    });
  }
}

export async function destroyBot(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  context: AdapterContext,
  options: { deleteMemories: boolean },
) {
  const [dedicated, activeRuns, routines] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { scopeKey: computerScopeKey("dedicated", bot.spaceId, bot.id) },
    }),
    deps.prisma.run.findMany({
      where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    }),
    deps.prisma.routine.findMany({ where: { botId: bot.id }, select: { id: true } }),
  ]);
  const runIds = activeRuns.map((run) => run.id);
  await deps.prisma.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  await Promise.allSettled([
    ...activeRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
    ...routines.map((routine) => deps.jobs.cancel(routineJobKey(routine.id))),
  ]);
  await releaseTeamComputerScreen(deps, bot, dedicated?.id, context);
  if (dedicated?.providerRef) {
    await deps.sandbox.destroy(toComputerRef(dedicated), context).catch(() => undefined);
  }
  // Keep the bot deletion transaction from committing if raw transcript cleanup fails.
  await removePiBotSessions(deps.dataDir, bot.userId, bot.id);
  const deletion = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; webhookSecretId: string | null }>>`
        SELECT id, "webhookSecretId"
        FROM bots
        WHERE id = ${bot.id} AND "spaceId" = ${bot.spaceId}
        FOR UPDATE
      `;
      const webhookSecretId = locked[0]?.webhookSecretId ?? bot.webhookSecretId ?? null;
      const botArtifacts = await tx.artifact.findMany({
        where: { botId: bot.id, groupId: null, spaceId: bot.spaceId },
        select: { storageKey: true },
      });
      await tx.artifact.deleteMany({
        where: { botId: bot.id, groupId: null, spaceId: bot.spaceId },
      });
      const groupCleanup = await detachBotFromGroups(tx, bot.id);
      await tx.computerExecutionLease.deleteMany({ where: { botId: bot.id } });
      await tx.computer.updateMany({
        where: {
          ...(dedicated ? { id: { not: dedicated.id } } : {}),
          OR: [{ controlBotId: bot.id }, { executionBotId: bot.id }],
        },
        data: releasedComputerLease(),
      });
      if (!options.deleteMemories) {
        const directory = archivedMemoryDirectory(bot.name, bot.id);
        await tx.$executeRaw`
          UPDATE "memory_documents"
          SET "botId" = NULL,
              "scope" = 'user',
              "path" = ${directory} || '/' || "path",
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "botId" = ${bot.id}
        `;
      }
      await tx.botDeletion.create({
        data: {
          id: bot.id,
          spaceId: bot.spaceId,
          name: bot.name,
          deletedByUserId: context.userId,
          memoriesPreserved: !options.deleteMemories,
        },
      });
      await tx.bot.delete({ where: { id: bot.id } });
      if (webhookSecretId) {
        await tx.secret.deleteMany({
          where: { id: webhookSecretId, kind: "webhook", spaceId: bot.spaceId },
        });
      }
      if (dedicated) await tx.computer.delete({ where: { id: dedicated.id } });
      return {
        artifactKeys: [
          ...botArtifacts.map((artifact) => artifact.storageKey),
          ...groupCleanup.artifactKeys,
        ],
        cancelledGroupRuns: groupCleanup.cancelledRuns,
      };
    }),
  );
  await Promise.allSettled(
    deletion.cancelledGroupRuns.map((run) => deps.jobs.cancel(runJobKey(run.id))),
  );
  const stoppedGroupBots = [
    ...new Map(
      deletion.cancelledGroupRuns.map((run) => [
        run.botId,
        { id: run.botId, computer: run.computer },
      ]),
    ).values(),
  ];
  await Promise.all(
    stoppedGroupBots.map(async (stoppedBot) => {
      if (!stoppedBot.computer?.providerRef) return;
      await deps.sandbox
        .releaseScreen?.(toComputerRef(stoppedBot.computer), {
          ...context,
          operationId: `destroy-group-run:${stoppedBot.id}`,
          botId: stoppedBot.id,
        })
        .catch(() => undefined);
    }),
  );
  if (dedicated) {
    await rm(resolveAgentHomePath(deps.home, dedicated.homeKey, deps.dataDir ?? "./data"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
  const artifactStore = deps.artifacts;
  if (artifactStore) {
    await removeStoredArtifacts(artifactStore, deletion.artifactKeys, context);
  }
}

async function detachBotFromGroups(tx: Prisma.TransactionClient, botId: string) {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT groups.id
    FROM chat_groups AS groups
    INNER JOIN chat_group_members AS members ON members."groupId" = groups.id
    WHERE members."botId" = ${botId}
    ORDER BY groups.id
    FOR UPDATE OF groups
  `;
  const affectedGroups = await tx.chatGroup.findMany({
    where: { members: { some: { botId } } },
    include: {
      members: {
        select: { botId: true, bot: { select: { archivedAt: true } } },
      },
      thread: { select: { id: true } },
    },
  });
  const dissolvedGroupIds: string[] = [];
  for (const group of affectedGroups) {
    const activeMembersAfterDeletion = group.members.filter(
      (member) => member.botId !== botId && member.bot.archivedAt === null,
    ).length;
    if (activeMembersAfterDeletion < GROUP_MEMBER_MIN) {
      dissolvedGroupIds.push(group.id);
    }
  }
  const dissolvedGroupIdSet = new Set(dissolvedGroupIds);
  const dissolvedThreadIds = affectedGroups
    .filter((group) => dissolvedGroupIdSet.has(group.id))
    .flatMap((group) => (group.thread ? [group.thread.id] : []));
  const activeRuns = dissolvedThreadIds.length
    ? await tx.run.findMany({
        where: {
          threadId: { in: dissolvedThreadIds },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: {
          id: true,
          taskId: true,
          botId: true,
          bot: {
            select: {
              computer: { select: { homeKey: true, kind: true, providerRef: true } },
            },
          },
        },
      })
    : [];
  if (activeRuns.length) {
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    await cancelRunsInTransaction(tx, activeRuns, now);
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: runIds } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  }
  if (affectedGroups.length) {
    await tx.chatGroupMember.deleteMany({ where: { botId } });
  }
  const groupArtifacts = dissolvedGroupIds.length
    ? await tx.artifact.findMany({
        where: { groupId: { in: dissolvedGroupIds } },
        select: { storageKey: true },
      })
    : [];
  if (dissolvedGroupIds.length) {
    await tx.chatGroup.deleteMany({ where: { id: { in: dissolvedGroupIds } } });
  }
  return {
    artifactKeys: groupArtifacts.map((artifact) => artifact.storageKey),
    cancelledRuns: activeRuns.map((run) => ({
      id: run.id,
      botId: run.botId,
      computer: run.bot.computer,
    })),
  };
}

async function removeStoredArtifacts(
  artifacts: ArtifactStore | undefined,
  storageKeys: string[],
  context: AdapterContext,
) {
  if (!artifacts) return;
  const results = await Promise.allSettled(
    [...new Set(storageKeys)].map((storageKey) => artifacts.remove(storageKey, context)),
  );
  for (const result of results) {
    if (result.status === "rejected") getLogger().error("group artifact cleanup", result.reason);
  }
}

function archivedMemoryDirectory(name: string, botId: string) {
  const safeName = name.replace(/[\\/]/g, "-").trim() || "Bot";
  return `Archived bots/${safeName} (${botId})`;
}

function releasedComputerLease() {
  return {
    controlHolder: "none" as const,
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
    executionRunId: null,
    executionBotId: null,
    executionLeaseExpiresAt: null,
  };
}

async function releaseTeamComputerScreen(
  deps: BotLifecycleDeps,
  bot: LifecycleBot,
  dedicatedId: string | undefined,
  context: AdapterContext,
) {
  if (!bot.computerId || bot.computerId === dedicatedId) return;
  const computer = await deps.prisma.computer.findUnique({ where: { id: bot.computerId } });
  if (!computer?.providerRef) return;
  await deps.sandbox.releaseScreen?.(toComputerRef(computer), context).catch(() => undefined);
}
