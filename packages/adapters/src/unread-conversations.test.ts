import {
  acceptSpaceInvitation,
  bootstrapUserSpace,
  createRepos,
  createSpaceInvitations,
  setBotSharing,
  sharedBotThread,
} from "@tangow/db";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterAll, beforeAll, expect, it } from "vitest";
import { unreadConversationCount } from "./executor.js";

let database: PgliteDatabase;

beforeAll(async () => {
  database = await openPgliteDatabase();
}, 60_000);
afterAll(() => database.close());

it("counts unread threads of live bots, a member's with a shared bot until it is unshared", async () => {
  const { prisma } = database;
  const env = { signupsEnabled: "true", signupAllowlist: undefined };
  for (const id of ["owner", "member"]) {
    await prisma.user.create({ data: { id, name: id, email: `${id}@tangow.test` } });
  }
  const spaceId = (await bootstrapUserSpace(prisma, { id: "owner" }, env)).spaceId;
  await bootstrapUserSpace(prisma, { id: "member" }, env);
  const [invitation] = await createSpaceInvitations(prisma, {
    spaceId,
    userId: "owner",
    emails: ["member@tangow.test"],
  });
  await acceptSpaceInvitation(prisma, { token: invitation!.id, userId: "member" });
  const actor = (userId: string) => ({
    userId,
    spaceId,
    email: `${userId}@tangow.test`,
    isDeploymentOwner: false,
  });
  const bot = await createRepos(prisma).createBot(actor("owner"), {
    name: "Shared",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await setBotSharing(prisma, actor("owner"), { botId: bot.id, visibility: "space", userIds: [] });
  const shared = await sharedBotThread(prisma, actor("member"), bot.id);
  await prisma.thread.update({ where: { id: shared!.thread.id }, data: { unread: true } });

  expect(await unreadConversationCount(prisma, "member")).toBe(1);
  expect(await unreadConversationCount(prisma, "owner")).toBe(0);
  await prisma.thread.update({ where: { id: bot.threadId }, data: { unread: true } });
  expect(await unreadConversationCount(prisma, "owner")).toBe(1);
  await prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: new Date() } });
  expect(await unreadConversationCount(prisma, "owner")).toBe(0);
  expect(await unreadConversationCount(prisma, "member")).toBe(0);
  await prisma.bot.update({ where: { id: bot.id }, data: { archivedAt: null } });

  await setBotSharing(prisma, actor("owner"), {
    botId: bot.id,
    visibility: "private",
    userIds: [],
  });
  expect(await unreadConversationCount(prisma, "member")).toBe(0);
});
