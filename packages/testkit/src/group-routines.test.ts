import { createGroupRepos } from "@rakazo/db";
import { afterEach, expect, it } from "vitest";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The fixture's bot shared with the Space, in a group of its owner and Ana. */
async function sharedBotGroup() {
  const run = await startWorkerRun({ steps: [], computerScope: "none" });
  cleanups.push(() => run.close());
  const { prisma, bot } = run;
  const owner = bot.userId;
  const space = await prisma.space.findUniqueOrThrow({ where: { id: bot.spaceId } });
  const joined = { organizationId: space.organizationId, userId: "ana", createdAt: new Date() };
  await prisma.user.create({ data: { id: "ana", name: "Ana", email: "ana@rakazo.test" } });
  await prisma.member.create({ data: { ...joined, id: "member-ana", role: "member" } });
  await prisma.spaceMember.create({
    data: { ...joined, id: "space-member-ana", spaceId: space.id, role: "member" },
  });
  await prisma.bot.update({ where: { id: bot.id }, data: { visibility: "space" } });
  const group = await prisma.chatGroup.create({
    data: {
      spaceId: space.id,
      userId: owner,
      name: "Crew",
      members: { create: { botId: bot.id } },
      people: { create: [{ userId: owner }, { userId: "ana" }] },
    },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: space.id, userId: owner, groupId: group.id },
  });
  const dueAt = new Date(Date.now() - 1_000);
  const routine = (userId: string) =>
    prisma.routine.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        userId,
        threadId: thread.id,
        name: "Digest",
        prompt: "Post the digest",
        crons: ["0 9 * * *"],
        timezone: "UTC",
        active: true,
        nextRunAt: dueAt,
      },
    });
  const runsOf = (routineId: string) =>
    prisma.run.findMany({ where: { routineId }, select: { threadId: true, userId: true } });
  const actor = (userId: string) => ({
    userId,
    spaceId: space.id,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  });
  return { run, owner, group, thread, dueAt, routine, runsOf, actor };
}

it("runs a person's routine on someone else's shared bot in their group, until they leave", async () => {
  const { run, group, thread, dueAt, routine, runsOf, actor } = await sharedBotGroup();
  const anas = await routine("ana");

  await run.wakeRoutine(anas.id, dueAt);
  expect(await runsOf(anas.id)).toEqual([{ threadId: thread.id, userId: "ana" }]);

  await createGroupRepos(run.prisma).leaveGroup(actor("ana"), group.id);
  expect(await run.prisma.routine.findUniqueOrThrow({ where: { id: anas.id } })).toMatchObject({
    active: false,
    nextRunAt: null,
  });
});

it("posts nowhere a routine of someone no longer in its group", async () => {
  const { run, owner, group, dueAt, routine, runsOf } = await sharedBotGroup();
  const owners = await routine(owner);
  await run.prisma.chatGroupPerson.deleteMany({ where: { groupId: group.id, userId: owner } });

  await run.wakeRoutine(owners.id, dueAt);
  expect(await runsOf(owners.id)).toEqual([]);
});
