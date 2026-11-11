import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import { setBotSharing } from "./bot-sharing.js";
import type { PrismaClient } from "./client.js";
import { claimSteering, finalizeRun, messageHelper } from "./events.js";
import { createGroupRepos, GroupCreatorCannotLeaveError } from "./groups.js";
import { createThreadMessageInTransaction } from "./messages.js";
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
  /** A run of the shared bot someone woke in the group, held by a worker. */
  const holdRun = async (
    userId: string,
    threadId: string,
    extra: { trigger?: string; parentRunId?: string } = {},
  ) => {
    const owned = { spaceId: space, botId: sharedBot, threadId, userId };
    const task = await prisma.task.create({
      data: { ...owned, prompt: "Work", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        ...owned,
        taskId: task.id,
        status: "running",
        trigger: extra.trigger ?? "user",
        parentRunId: extra.parentRunId,
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    await prisma.attempt.create({ data: { runId: run.id, fence: 1, status: "running" } });
    return run;
  };
  const fail = async (run: { id: string; taskId: string; threadId: string }) =>
    finalizeRun(prisma, {
      spaceId: space,
      threadId: run.threadId,
      botId: sharedBot,
      runId: run.id,
      taskId: run.taskId,
      attemptId: (await prisma.attempt.findFirstOrThrow({ where: { runId: run.id } })).id,
      leaseOwner: "worker",
      leaseFence: 1,
      outcome: "failed",
      error: "failed",
    });
  /** What someone sent a run of theirs while it worked. */
  const steer = (userId: string, threadId: string, runId: string) =>
    prisma.$transaction(async (tx) => {
      const message = await createThreadMessageInTransaction(tx, {
        threadId,
        role: "user",
        authorId: userId,
        feedBotId: sharedBot,
        blocks: [{ kind: "text", text: `From ${userId}` }],
      });
      await tx.steeringMessage.create({
        data: { messageId: message.id, botId: sharedBot, userId, runId },
      });
    });
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

  it("tells each person which of the group's bots they can wake", async () => {
    const groups = createGroupRepos(prisma);
    const group = await newGroup(["ben"]);
    const usable = async (userId: string) =>
      (await groups.mapGroup(await groups.getGroup(actor(userId), group.id), userId)).members.map(
        (member) => [member.botId, member.canUse],
      );
    expect(group.members.every((member) => member.canUse)).toBe(true);
    expect(await usable("ben")).toEqual([
      [creatorBot, false],
      [sharedBot, true],
    ]);
    const [listed] = await groups.listSpaceGroupsForSpaces(actor("ben"), [space]);
    expect(listed?.members.map((member) => member.canUse)).toEqual([false, true]);
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

  it("keeps each person's messages to their own runs of a bot", async () => {
    const group = await newGroup(["ana"]);
    const anaRun = await holdRun("ana", group.threadId);
    const creatorRun = await holdRun("creator", group.threadId);
    await steer("creator", group.threadId, creatorRun.id);
    const claim = () =>
      claimSteering(prisma, {
        threadId: group.threadId,
        botId: sharedBot,
        runId: anaRun.id,
        leaseOwner: "worker",
        leaseFence: 1,
        seenIds: [],
      });

    const ended = await fail(creatorRun);
    const continuation = await prisma.run.findUniqueOrThrow({
      where: { id: (ended && ended.continuationRunId) || "" },
    });
    expect(continuation.userId).toBe("creator");
    expect(await claim()).toEqual([]);

    await prisma.steeringMessage.updateMany({
      where: { userId: "creator" },
      data: { runId: null },
    });
    expect(await claim()).toEqual([]);
  });

  it("lets a run message only its own person's helpers", async () => {
    const group = await newGroup(["ana"]);
    const anaRun = await holdRun("ana", group.threadId);
    const anaHelper = await holdRun("ana", group.threadId, {
      trigger: "helper",
      parentRunId: anaRun.id,
    });
    const tell = (userId: string) =>
      messageHelper(prisma, {
        threadId: group.threadId,
        botId: sharedBot,
        userId,
        helperId: anaHelper.id,
        text: "Faster",
      });

    expect(await tell("creator")).toBe("unknown");
    expect(await tell("ana")).toBe("steered");
  });

  it("wakes the bot for a helper's report as the person whose run started it", async () => {
    const group = await newGroup(["ana"]);
    await holdRun("creator", group.threadId);
    const anaRun = await holdRun("ana", group.threadId);
    const helper = await holdRun("ana", group.threadId, {
      trigger: "helper",
      parentRunId: anaRun.id,
    });
    await prisma.run.update({ where: { id: anaRun.id }, data: { status: "completed" } });

    const ended = await fail(helper);
    const woken = await prisma.run.findUniqueOrThrow({
      where: { id: (ended && ended.continuationRunId) || "" },
    });
    expect(woken.userId).toBe("ana");
  });
});
