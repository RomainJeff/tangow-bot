import {
  type Actor,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  type Group,
  type GroupMember,
  type SpaceGroup,
} from "@rakazo/contracts";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { Prisma, type PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { activeRunStatuses, ownerRunSelection, sessionPreviews } from "./thread-listing.js";

type GroupRecord = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  description: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  thread: { id: string; sessionId: string } | null;
  people: PersonRecord[];
  members: Array<{
    bot: {
      id: string;
      name: string;
      color: string;
      shapeSeed: number | null;
      runs: Array<{ status: string }>;
    };
  }>;
};

type PersonRecord = { userId: string; unread: boolean; pinned: boolean; sectionId: string | null };

type SpaceGroupRecord = Pick<
  GroupRecord,
  "id" | "spaceId" | "name" | "updatedAt" | "members" | "people"
> & {
  thread: { sessionId: string } | null;
};

/** The actor's own read, pin and section state in a group they are a person in. */
function personState(people: PersonRecord[], userId: string) {
  const person = people.find((row) => row.userId === userId);
  if (!person) throw new IsolationError();
  return { pinned: person.pinned, sectionId: person.sectionId, unread: person.unread };
}

/** Pinned first, then the most recently active. */
function byPinThenActivity(
  a: { pinned: boolean; updatedAt: string },
  b: { pinned: boolean; updatedAt: string },
) {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt);
}

function mapGroupMembers(members: GroupRecord["members"]): GroupMember[] {
  return members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
    shapeSeed: member.bot.shapeSeed,
    status: member.bot.runs[0]?.status ?? "idle",
  }));
}

function mapGroup(group: GroupRecord, preview: string, userId: string): Group {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  const { unread, ...organization } = personState(group.people, userId);
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    description: group.description,
    ...organization,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    members: mapGroupMembers(group.members),
    threadId: group.thread.id,
    preview,
    unread,
    updatedAt: group.updatedAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
  };
}

function mapSpaceGroup(group: SpaceGroupRecord, preview: string, userId: string): SpaceGroup {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    ...personState(group.people, userId),
    members: mapGroupMembers(group.members),
    preview,
    updatedAt: group.updatedAt.toISOString(),
  };
}

function hasMinimumActiveMembers(members: readonly unknown[]) {
  return members.length >= GROUP_MEMBER_MIN;
}

async function assertOwnedBots(
  prisma: PrismaClient,
  actor: Actor,
  botIds: string[],
): Promise<GroupMember[]> {
  const unique = [...new Set(botIds)];
  if (unique.length < GROUP_MEMBER_MIN || unique.length > GROUP_MEMBER_MAX) {
    throw new IsolationError(
      `Groups require ${GROUP_MEMBER_MIN} to ${GROUP_MEMBER_MAX} distinct bots`,
    );
  }
  const bots = await prisma.bot.findMany({
    where: {
      id: { in: unique },
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    select: { id: true, name: true, color: true, shapeSeed: true },
  });
  if (bots.length !== unique.length) throw new IsolationError();
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  return unique.map((botId) => {
    const bot = botsById.get(botId);
    if (!bot) throw new IsolationError();
    return { botId: bot.id, name: bot.name, color: bot.color, shapeSeed: bot.shapeSeed };
  });
}

const peopleSelection = {
  select: { userId: true, unread: true, pinned: true, sectionId: true },
  orderBy: { createdAt: "asc" as const },
} as const;

const groupInclude = {
  thread: { select: { id: true, sessionId: true } },
  people: peopleSelection,
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          shapeSeed: true,
          runs: ownerRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const groupTargetInclude = {
  thread: { select: { id: true } },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          shapeSeed: true,
          runs: ownerRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

/** The previews of the groups' threads, by thread session. */
async function groupPreviews(
  prisma: PrismaClient,
  groups: ReadonlyArray<{ thread: { sessionId: string } | null }>,
): Promise<Map<string, string>> {
  return sessionPreviews(
    prisma,
    groups.flatMap((group) => group.thread?.sessionId ?? []),
  );
}

export function createGroupRepos(prisma: PrismaClient) {
  async function presentGroup(group: GroupRecord, userId: string): Promise<Group> {
    const previews = await groupPreviews(prisma, [group]);
    return mapGroup(group, (group.thread && previews.get(group.thread.sessionId)) ?? "", userId);
  }

  async function listSpaceGroupsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceGroup[]> {
    if (spaceIds.length === 0) return [];
    const groups = await prisma.chatGroup.findMany({
      where: {
        spaceId: { in: spaceIds },
        ...groupMembershipFilter(actor.userId),
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        updatedAt: true,
        thread: { select: { sessionId: true } },
        members: groupInclude.members,
        people: peopleSelection,
      },
    });
    const listed = groups.filter((group) => hasMinimumActiveMembers(group.members));
    const previews = await groupPreviews(prisma, listed);
    return listed
      .map((group) =>
        mapSpaceGroup(
          group,
          (group.thread && previews.get(group.thread.sessionId)) ?? "",
          actor.userId,
        ),
      )
      .sort(byPinThenActivity);
  }

  return {
    async listGroups(actor: Actor, options: { archived?: boolean } = {}): Promise<Group[]> {
      const groups = await prisma.chatGroup.findMany({
        where: {
          ...groupMembershipFilter(actor.userId, actor.spaceId),
          archivedAt: options.archived ? { not: null } : null,
        },
        include: groupInclude,
      });
      const listed = groups.filter((group) => hasMinimumActiveMembers(group.members));
      const previews = await groupPreviews(prisma, listed);
      return listed
        .map((group) =>
          mapGroup(
            group,
            (group.thread && previews.get(group.thread.sessionId)) ?? "",
            actor.userId,
          ),
        )
        .sort(byPinThenActivity);
    },

    listSpaceGroupsForSpaces,

    async getGroup(actor: Actor, groupId: string, options: { includeArchived?: boolean } = {}) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          ...groupMembershipFilter(actor.userId, actor.spaceId),
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: groupInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group as GroupRecord;
    },

    async getGroupTarget(actor: Actor, groupId: string) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          ...groupMembershipFilter(actor.userId, actor.spaceId),
          archivedAt: null,
        },
        include: groupTargetInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group;
    },

    async createGroup(
      actor: Actor,
      input: { name: string; description?: string; botIds: string[] },
    ): Promise<Group> {
      const members = await assertOwnedBots(prisma, actor, input.botIds);
      const created = await prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, {
          spaceId: actor.spaceId,
          userId: actor.userId,
        });
        const group = await tx.chatGroup.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: input.name.trim(),
            description: input.description?.trim() ?? "",
          },
        });
        await tx.chatGroupMember.createMany({
          data: members.map((member) => ({ groupId: group.id, botId: member.botId })),
        });
        await tx.chatGroupPerson.create({ data: { groupId: group.id, userId: actor.userId } });
        await tx.thread.create({
          data: {
            spaceId: actor.spaceId,
            groupId: group.id,
            userId: actor.userId,
          },
        });
        return tx.chatGroup.findFirstOrThrow({
          where: { id: group.id },
          include: groupInclude,
        });
      });
      return mapGroup(created, "", actor.userId);
    },

    async updateGroup(
      actor: Actor,
      input: {
        groupId: string;
        name?: string;
        description?: string;
        botIds?: string[];
        pinned?: boolean;
        sectionId?: string | null;
      },
    ): Promise<{ group: Group; cancelledRunIds: string[] }> {
      const members = input.botIds ? await assertOwnedBots(prisma, actor, input.botIds) : undefined;
      const updated = await prisma.$transaction(async (tx) => {
        // Anyone in the group pins and files it for themselves; only its creator changes it.
        const manages =
          input.name !== undefined || input.description !== undefined || members !== undefined;
        await (manages ? lockGroupForCreator : lockGroupForPerson)(tx, actor, input.groupId);
        const current = await tx.chatGroup.findFirst({
          where: { id: input.groupId, archivedAt: null },
          include: {
            members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
            thread: { select: { id: true } },
          },
        });
        if (!current?.thread) throw new IsolationError();
        if (
          !members &&
          !hasMinimumActiveMembers(
            current.members.filter((member) => member.bot.archivedAt === null),
          )
        ) {
          throw new IsolationError();
        }
        const nextBotIds = new Set(
          members?.map((member) => member.botId) ?? current.members.map((member) => member.botId),
        );
        const removedBotIds = current.members
          .map((member) => member.botId)
          .filter((botId) => !nextBotIds.has(botId));
        const activeRuns = removedBotIds.length
          ? await tx.run.findMany({
              where: {
                threadId: current.thread.id,
                botId: { in: removedBotIds },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true },
            })
          : [];
        if (activeRuns.length) {
          const now = new Date();
          await cancelRunsInTransaction(tx, activeRuns, now);
        }
        if (input.name !== undefined) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { name: input.name.trim() },
          });
        }
        if (members) {
          await tx.chatGroupMember.deleteMany({ where: { groupId: input.groupId } });
          await tx.chatGroupMember.createMany({
            data: members.map((member) => ({ groupId: input.groupId, botId: member.botId })),
          });
        }
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: { updatedAt: new Date(), description: input.description?.trim() },
        });
        if (input.pinned !== undefined || input.sectionId !== undefined) {
          await tx.chatGroupPerson.update({
            where: { groupId_userId: { groupId: input.groupId, userId: actor.userId } },
            data: { pinned: input.pinned, sectionId: input.sectionId },
          });
        }
        return tx.chatGroup
          .findFirstOrThrow({
            where: { id: input.groupId },
            include: groupInclude,
          })
          .then((group) => ({ group, cancelledRunIds: activeRuns.map((run) => run.id) }));
      });
      if (!updated.group.thread) throw new IsolationError();
      return {
        group: await presentGroup(updated.group, actor.userId),
        cancelledRunIds: updated.cancelledRunIds,
      };
    },

    async archiveGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockGroupForCreator(tx, actor, groupId);
        const current = await tx.chatGroup.findFirst({
          where: { id: groupId, archivedAt: null },
          select: { thread: { select: { id: true } } },
        });
        if (!current?.thread) throw new IsolationError();

        const activeRuns = await tx.run.findMany({
          where: {
            threadId: current.thread.id,
            status: { in: activeRunStatuses },
          },
          select: { id: true, taskId: true },
        });
        const runIds = activeRuns.map((run) => run.id);
        const now = new Date();
        const computers = runIds.length
          ? await tx.computer.findMany({
              where: { executionRunId: { in: runIds } },
              select: {
                id: true,
                homeKey: true,
                kind: true,
                providerRef: true,
                executionBotId: true,
                executionRunId: true,
              },
            })
          : [];
        const leases = runIds.length
          ? await tx.computerExecutionLease.findMany({
              where: { runId: { in: runIds } },
              select: { computerId: true, runId: true, fence: true },
            })
          : [];
        const leaseByComputerId = new Map(leases.map((lease) => [lease.computerId, lease]));
        const computersWithLease = computers.map((computer) => ({
          ...computer,
          executionFence: leaseByComputerId.get(computer.id)?.fence ?? 0,
        }));

        if (runIds.length) {
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
          await tx.event.deleteMany({
            where: { type: "thread.progress", runId: { in: runIds } },
          });
        }

        await tx.chatGroup.update({ where: { id: groupId }, data: { archivedAt: now } });
        await tx.chatGroupPerson.updateMany({ where: { groupId }, data: { pinned: false } });

        return { cancelledRunIds: runIds, computers: computersWithLease };
      });
    },

    async restoreGroup(actor: Actor, groupId: string) {
      const restored = await prisma.chatGroup.updateMany({
        where: { id: groupId, spaceId: actor.spaceId, userId: actor.userId },
        data: { archivedAt: null },
      });
      if (restored.count !== 1) throw new IsolationError();
    },

    async removeGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockGroupForCreator(tx, actor, groupId);
        const group = await tx.chatGroup.findUnique({
          where: { id: groupId },
          select: {
            artifacts: { select: { storageKey: true } },
            members: { orderBy: { createdAt: "asc" }, take: 1, select: { botId: true } },
          },
        });
        const contextBotId = group?.members[0]?.botId;
        if (!contextBotId) throw new IsolationError();
        await tx.chatGroup.delete({ where: { id: groupId } });
        return {
          contextBotId,
          artifactStorageKeys: group.artifacts.map((artifact) => artifact.storageKey),
        };
      });
    },

    mapGroup: presentGroup,
  };
}

/** The groups `userId` is a person in, the creator among them. */
export function groupMembershipFilter(
  userId: string,
  spaceId?: string,
): Prisma.ChatGroupWhereInput {
  return { ...(spaceId ? { spaceId } : {}), people: { some: { userId } } };
}

/** SQL for "`userId` is a person in the group `groupId`", for raw queries; see the filter above. */
export function groupPersonSql(userId: string, groupId: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM chat_group_people p WHERE p."groupId" = ${groupId} AND p."userId" = ${userId}
  )`;
}

/** Locks a group the actor is a person in, for reading it or writing in its thread. */
export async function lockGroupForPerson(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT g.id
    FROM chat_groups g
    WHERE g.id = ${groupId}
      AND g."spaceId" = ${actor.spaceId}
      AND ${groupPersonSql(actor.userId, Prisma.sql`g.id`)}
    FOR UPDATE OF g
  `;
  if (locked.length !== 1) throw new IsolationError();
}

/** Locks a group the actor created: only they change it, archive it or delete it. */
export async function lockGroupForCreator(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

export async function touchGroupUpdatedAt(
  prisma: Pick<Prisma.TransactionClient, "chatGroup">,
  groupId: string,
) {
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });
}

/**
 * A new entry turns a thread unread for whoever did not write it: in a group, every other
 * person's own mark; elsewhere, the thread's one person's, unless they wrote it. No author is a
 * bot or the system, so everyone's.
 */
export async function markThreadUnread(
  tx: Pick<Prisma.TransactionClient, "thread" | "chatGroupPerson">,
  thread: { id: string; groupId: string | null; userId: string },
  authorId?: string,
) {
  if (thread.groupId) {
    await tx.chatGroupPerson.updateMany({
      where: {
        groupId: thread.groupId,
        unread: false,
        ...(authorId ? { userId: { not: authorId } } : {}),
      },
      data: { unread: true },
    });
  } else if (authorId === undefined || thread.userId !== authorId) {
    await tx.thread.update({ where: { id: thread.id }, data: { unread: true } });
  }
}

/** Marks threads unread for everyone in them: no person wrote what was added. */
export async function markThreadsUnread(
  tx: Pick<Prisma.TransactionClient, "thread" | "chatGroupPerson">,
  threadIds: string[],
) {
  await tx.thread.updateMany({
    where: { id: { in: threadIds }, groupId: null },
    data: { unread: true },
  });
  await tx.chatGroupPerson.updateMany({
    where: { unread: false, group: { thread: { id: { in: threadIds } } } },
    data: { unread: true },
  });
}
