import { RPCHandler } from "@orpc/server/fetch";
import { createInMemorySkillLock } from "@tangow/adapters";
import type { Actor } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tangow/db", async (importOriginal) => {
  const db = await importOriginal<typeof import("@tangow/db")>();
  return {
    ...db,
    createRepos: (prisma: PrismaClient) => ({
      ...db.createRepos(prisma),
      getBot: async () => ({ id: "bot-b", name: "Writer", computer: null }),
      createBot: async () => ({ id: "bot-c" }),
    }),
  };
});

const { createRouter } = await import("./router.js");
type RouterDeps = Parameters<typeof createRouter>[0];

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@tangow.test",
  isDeploymentOwner: false,
} satisfies Actor;

describe("bots.duplicate", () => {
  it("copies the source bot's skill access only once the owner's held skill write is done", async () => {
    type Row = { botId: string; skillKey: string; enabled: boolean };
    const rows: Row[] = [{ botId: "bot-b", skillKey: "user:deploy", enabled: true }];
    const prisma = {
      botMcpServer: { findMany: vi.fn(async () => []) },
      botSkill: {
        findMany: vi.fn(async ({ where }: { where: { botId: string } }) =>
          rows.filter((row) => row.botId === where.botId).map((row) => ({ ...row })),
        ),
        createMany: vi.fn(async ({ data }: { data: Row[] }) => {
          rows.push(...data);
          return { count: data.length };
        }),
      },
    } as unknown as PrismaClient;
    const skillLock = createInMemorySkillLock();
    const handler = new RPCHandler(
      createRouter({ prisma, skillLock, dataDir: "/tmp/tangow-duplicate" } as RouterDeps),
    );

    let release = () => {};
    const held = skillLock.run(
      actor,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const duplicated = handler.handle(
      new Request("http://127.0.0.1/rpc/bots/duplicate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-b" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    rows.splice(0, rows.length, { botId: "bot-b", skillKey: "user:renamed", enabled: true });
    release();
    await held;

    await duplicated;
    expect(rows).toEqual([
      { botId: "bot-b", skillKey: "user:renamed", enabled: true },
      {
        botId: "bot-c",
        skillKey: "user:renamed",
        enabled: true,
        spaceId: "space-1",
        userId: "user-1",
      },
    ]);
  });
});
