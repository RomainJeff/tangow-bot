import type { AdapterContext, MemoryCommitRequest } from "@rakazo/adapter-kit";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("memory commits (PostgreSQL)", () => {
  const context: AdapterContext = {
    operationId: "memory-commit-test",
    traceId: "memory-commit-test",
    spaceId: "memory-commit-space",
    userId: "memory-commit-user",
    signal: new AbortController().signal,
  };
  let prisma: PrismaClient;
  let store: MarkdownMemoryStore;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    store = new MarkdownMemoryStore(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const createdAt = new Date();
    await prisma.user.create({
      data: {
        id: context.userId,
        name: "Memory Commit User",
        email: "memory-commit-user@rakazo.test",
      },
    });
    await prisma.organization.create({
      data: {
        id: context.spaceId,
        name: "Memory Test Organization",
        slug: context.spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: context.spaceId,
            name: "Memory Test Space",
            bots: {
              create: {
                id: "memory-commit-bot",
                userId: context.userId,
                name: "Memory Test Bot",
                color: "ink",
              },
            },
          },
        },
      },
    });
    await prisma.member.create({
      data: {
        id: "memory-commit-member",
        organizationId: context.spaceId,
        userId: context.userId,
        role: "owner",
        createdAt,
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: "memory-commit-space-member",
        spaceId: context.spaceId,
        organizationId: context.spaceId,
        userId: context.userId,
        role: "owner",
        createdAt,
      },
    });
    await prisma.thread.create({
      data: {
        id: "memory-commit-thread",
        spaceId: context.spaceId,
        botId: "memory-commit-bot",
        userId: context.userId,
      },
    });
    await prisma.memoryCollection.createMany({
      data: [
        { spaceId: context.spaceId, kind: "personal", ownerUserId: context.userId },
        {
          spaceId: context.spaceId,
          kind: "agent",
          ownerUserId: context.userId,
          botId: "memory-commit-bot",
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: context.spaceId } });
      await prisma.user.deleteMany({ where: { id: context.userId } });
    } finally {
      await close();
    }
  });

  function request(path: string, content: string): MemoryCommitRequest {
    return {
      scope: "user",
      path,
      content,
      sourceThreadId: "memory-commit-thread",
    };
  }

  it("creates a proposed document without modifying an approved document", async () => {
    const collection = await prisma.memoryCollection.findFirstOrThrow({
      where: { spaceId: context.spaceId, kind: "personal", ownerUserId: context.userId },
    });
    const approved = await prisma.memoryDocument.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        collectionId: collection.id,
        scope: "user",
        path: "MEMORY.md",
        title: "Approved fact",
        content: "approved fact",
        status: "active",
      },
    });

    const proposed = await store.commit(request("MEMORY.md", "runtime fact"), context);

    expect(proposed.id).not.toBe(approved.id);
    expect(
      await prisma.memoryDocument.findUniqueOrThrow({ where: { id: approved.id } }),
    ).toMatchObject({
      content: "approved fact",
      status: "active",
      revision: 1,
    });
    expect(
      await prisma.memoryDocument.findUniqueOrThrow({ where: { id: proposed.id } }),
    ).toMatchObject({
      status: "proposed",
      revision: 1,
      content: "runtime fact",
      sourceKind: "thread",
      sourceReferenceId: "memory-commit-thread",
    });
    expect(
      await prisma.memoryRevision.findFirstOrThrow({
        where: { documentId: proposed.id, revision: 1 },
      }),
    ).toMatchObject({
      content: "runtime fact",
      sourceRunId: null,
      sourceThreadId: "memory-commit-thread",
      sourceKind: "thread",
      sourceReferenceId: "memory-commit-thread",
      status: "proposed",
    });
  });

  it("deduplicates concurrent retries of the same runtime command", async () => {
    const command = request("retry.md", "same runtime fact");
    const [first, second] = await Promise.all([
      store.commit(command, context),
      store.commit(command, context),
    ]);

    expect(second).toEqual(first);
    expect(
      await prisma.memoryDocument.count({
        where: { spaceId: context.spaceId, content: "same runtime fact" },
      }),
    ).toBe(1);
  });

  it("rejects runtime commits from a non-member", async () => {
    await expect(
      store.commit(request("forbidden.md", "must not be stored"), {
        ...context,
        operationId: "non-member-operation",
        userId: "memory-commit-outsider",
      }),
    ).rejects.toMatchObject({ name: "IsolationError" });
    expect(
      await prisma.memoryDocument.findFirst({
        where: { spaceId: context.spaceId, content: "must not be stored" },
      }),
    ).toBeNull();
  });

  it("rolls back a rejected revision write and permits a retry", async () => {
    const command = request("rejected.md", "retry after rollback");
    let inserts = 0;
    const rejectingStore = new MarkdownMemoryStore(
      prisma.$extends({
        query: {
          memoryRevision: {
            async create({ args, query }) {
              inserts += 1;
              return query({
                ...args,
                data: { ...args.data, document: undefined, documentId: "missing-document" },
              });
            },
          },
        },
      }) as PrismaClient,
    );

    await expect(rejectingStore.commit(command, context)).rejects.toMatchObject({ code: "P2003" });
    expect(inserts).toBe(1);
    expect(
      await prisma.memoryDocument.findFirst({
        where: { spaceId: context.spaceId, content: command.content },
      }),
    ).toBeNull();

    const retried = await store.commit(command, context);
    expect(retried.content).toBe(command.content);
    expect(await prisma.memoryRevision.count({ where: { documentId: retried.id } })).toBe(1);
  });

  it("requires a bot owned by the runtime actor", async () => {
    await expect(
      store.commit(
        { ...request("forged-bot.md", "must not be stored"), scope: "bot", botId: "forged-bot" },
        context,
      ),
    ).rejects.toMatchObject({ name: "IsolationError" });
    expect(
      await prisma.memoryDocument.findFirst({
        where: { spaceId: context.spaceId, content: "must not be stored" },
      }),
    ).toBeNull();
  });
});
