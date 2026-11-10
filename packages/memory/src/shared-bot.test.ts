import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { openPgliteDatabase, type PgliteDatabase } from "@rakazo/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const SPACE = "shared-memory-space";
const BOT = "shared-memory-bot";

describe("memory on a shared bot", () => {
  let database: PgliteDatabase;
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  const as = (userId: string): AdapterContext => ({
    operationId: "shared-memory",
    traceId: "shared-memory",
    spaceId: SPACE,
    userId,
    botId: BOT,
    signal: new AbortController().signal,
  });

  beforeAll(async () => {
    database = await openPgliteDatabase();
    prisma = database.prisma;
    store = new MarkdownMemoryStore(prisma);
    await prisma.organization.create({
      data: {
        id: SPACE,
        name: "Studio",
        slug: SPACE,
        createdAt: new Date(),
        spaces: {
          create: {
            id: SPACE,
            name: "Studio",
            bots: { create: { id: BOT, userId: "owner", name: "Notes", color: "ink" } },
          },
        },
      },
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  it("keeps a bot memory for each person and one team memory under the owner", async () => {
    const save = (userId: string, scope: "bot" | "team", content: string) =>
      store.commit(
        { scope, botId: BOT, path: "MEMORY.md", content, mode: "append", sourceRunId: userId },
        as(userId),
      );
    await save("owner", "bot", "- Owner signs off as Ada");
    await save("dana", "bot", "- Dana signs off as D.");
    // Any person's run writes team memory under the owner, so a path has one team row.
    await save("owner", "team", "- Release notes go out on Thursdays");
    await save("owner", "team", "- Changelog lives in CHANGELOG.md");

    const read = async (userId: string, scope: "bot" | "team") =>
      (await store.read({ scope, botId: BOT }, as(userId))).documents.map((doc) => doc.content);
    expect(await read("owner", "bot")).toEqual(["- Owner signs off as Ada"]);
    expect(await read("dana", "bot")).toEqual(["- Dana signs off as D."]);
    expect(await read("owner", "team")).toEqual([
      "- Release notes go out on Thursdays\n- Changelog lives in CHANGELOG.md",
    ]);
    expect(await prisma.memoryDocument.count({ where: { botId: BOT, scope: "team" } })).toBe(1);
  });
});
