import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import { setBotSharing } from "./bot-sharing.js";
import type { PrismaClient } from "./client.js";
import { createGroupRepos, GroupCreatorCannotLeaveError } from "./groups.js";
import { openPgliteDatabase, type PgliteDatabase } from "./pglite.test-support.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";
import {
  acceptSpaceInvitation,
  createSpaceForMember,
  createSpaceInvitation,
  removeSpaceMember,
} from "./spaces.js";

const env = { signupsEnabled: "true", signupAllowlist: undefined };

describe("a group's people, bots and lead", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let space: string;
  let creatorBot: string;
  let sharedBot: string;
  let privateBot: string;

  const actor = (userId: string) => ({
    userId,
    spaceId: space,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });
  const newBot = async (userId: string, name: string) =>
    (
      await createRepos(prisma).createBot(actor(userId), {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      })
    ).id;
  const newGroup = (userIds: string[]) =>
    createGroupRepos(prisma).createGroup(actor("creator"), {
      name: "Crew",
      botIds: [creatorBot, sharedBot],
      userIds,
    });
  /** A run someone started in the group's thread. */
  const startRun = async (userId: string, threadId: string) => {
    const owned = { spaceId: space, botId: creatorBot, threadId, userId };
    const task = await prisma.task.create({
      data: { ...owned, prompt: "Work", status: "running" },
    });
    return prisma.run.create({
      data: { ...owned, taskId: task.id, status: "running", trigger: "user" },
    });
  };
  const status = async (runId: string) =>
    (await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    for (const id of ["creator", "ana", "ben", "stranger"]) {
      await prisma.user.create({ data: { id, name: id, email: `${id}@rakazo.test` } });
      await bootstrapUserSpace(prisma, { id }, env);
    }
    const home = (await prisma.spaceMember.findFirstOrThrow({ where: { userId: "creator" } }))
      .spaceId;
    space = (
      await createSpaceForMember(prisma, { currentSpaceId: home, userId: "creator", name: "Team" })
    ).id;
    for (const userId of ["ana", "ben"]) {
      const { token } = await createSpaceInvitation(prisma, { spaceId: space, userId: "creator" });
      await acceptSpaceInvitation(prisma, { token, userId });
    }
    creatorBot = await newBot("creator", "Planner");
    sharedBot = await newBot("ana", "Researcher");
    await setBotSharing(prisma, actor("ana"), {
      botId: sharedBot,
      visibility: "space",
      userIds: [],
    });
    privateBot = await newBot("ana", "Diary");
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("puts the Space's people and the bots the creator can use in a new group", async () => {
    const group = await newGroup(["ana"]);
    expect(group.people.map((person) => person.userId)).toEqual(["creator", "ana"]);
    expect(group.canManage).toBe(true);
    const seen = await createGroupRepos(prisma).getGroup(actor("ana"), group.id);
    expect((await createGroupRepos(prisma).mapGroup(seen, "ana")).canManage).toBe(false);

    await expect(newGroup(["stranger"])).rejects.toBeInstanceOf(IsolationError);
    await expect(
      createGroupRepos(prisma).createGroup(actor("creator"), {
        name: "Crew",
        botIds: [privateBot],
      }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("keeps the lead among the group's bots, and drops it when its bot leaves", async () => {
    const groups = createGroupRepos(prisma);
    const { id: groupId } = await newGroup([]);
    await expect(
      groups.updateGroup(actor("creator"), { groupId, leadBotId: privateBot }),
    ).rejects.toBeInstanceOf(IsolationError);
    const led = await groups.updateGroup(actor("creator"), { groupId, leadBotId: sharedBot });
    expect(led.group.leadBotId).toBe(sharedBot);
    const without = await groups.updateGroup(actor("creator"), { groupId, botIds: [creatorBot] });
    expect(without.group.leadBotId).toBeNull();
  });

  it("stops only the runs of whoever is taken out or leaves", async () => {
    const groups = createGroupRepos(prisma);
    const group = await newGroup(["ana", "ben"]);
    const [creatorRun, anaRun, benRun] = await Promise.all(
      ["creator", "ana", "ben"].map((userId) => startRun(userId, group.threadId)),
    );

    const removed = await groups.updateGroup(actor("creator"), {
      groupId: group.id,
      userIds: ["ben"],
    });
    expect(removed.group.people.map((person) => person.userId)).toEqual(["creator", "ben"]);
    expect(removed.cancelledRunIds).toEqual([anaRun!.id]);

    await expect(groups.leaveGroup(actor("creator"), group.id)).rejects.toBeInstanceOf(
      GroupCreatorCannotLeaveError,
    );
    expect(await groups.leaveGroup(actor("ben"), group.id)).toEqual({
      cancelledRunIds: [benRun!.id],
    });
    await expect(groups.getGroupTarget(actor("ben"), group.id)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(await status(creatorRun!.id)).toBe("running");
  });

  it("takes someone removed from the Space out of its groups and stops their runs there", async () => {
    const group = await newGroup(["ana", "ben"]);
    const [anaRun, benRun] = await Promise.all(
      ["ana", "ben"].map((userId) => startRun(userId, group.threadId)),
    );
    await removeSpaceMember(prisma, { spaceId: space, userId: "creator", memberUserId: "ben" });

    expect(await prisma.chatGroupPerson.count({ where: { userId: "ben" } })).toBe(0);
    expect(await status(benRun!.id)).toBe("cancelled");
    expect(await status(anaRun!.id)).toBe("running");
  });
});
