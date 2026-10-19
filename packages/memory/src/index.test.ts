import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({
      memoryDocument: { findMany },
      memoryEvidence: { findMany: vi.fn(async () => []) },
    } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          accessVersion: undefined,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          AND: [
            expect.objectContaining({
              spaceId: "workspace-1",
              status: "active",
              collection: {
                OR: [{ kind: "space" }, { ownerUserId: "user-1" }],
                NOT: { kind: "agent", botId: { not: "bot-1" } },
              },
            }),
            { scope: "bot", collection: { kind: "agent" } },
          ],
        }),
      }),
    );
  });

  it("queries shared memory only through a current membership and validity window", async () => {
    const findMany = vi.fn(async () => []);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await store.read({ scope: "user" }, context);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({
              space: { memberships: { some: { userId: "user-1" } } },
              collection: { OR: [{ kind: "space" }, { ownerUserId: "user-1" }] },
              status: "active",
              AND: [
                { OR: [{ validFrom: null }, { validFrom: { lte: expect.any(Date) } }] },
                { OR: [{ validUntil: null }, { validUntil: { gte: expect.any(Date) } }] },
              ],
            }),
            { scope: "user", collection: { kind: { in: ["space", "personal"] } } },
          ],
        },
      }),
    );
  });
});

describe("append commits", () => {
  /** Minimal Prisma stub: one document row, transactions run inline. */
  function stubPrisma(seed?: { content: string; revision: number }) {
    let row = seed ? { id: "memory-1", path: "MEMORY.md", ...seed } : undefined;
    const revisions: Array<{ revision: number; content: string }> = [];
    const tx = {
      spaceMember: { findFirst: vi.fn(async () => ({ id: "membership-1" })) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
      memoryCommand: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      memoryCollection: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "collection-1" })),
      },
      memoryDocument: {
        findFirst: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: { content: string; revision: number } }) => {
          row = { ...row!, ...data };
          return row;
        }),
        create: vi.fn(async ({ data }: { data: { content: string } }) => {
          row = { id: "memory-1", path: "MEMORY.md", content: data.content, revision: 1 };
          return row;
        }),
      },
      memoryRevision: {
        create: vi.fn(async ({ data }: { data: { revision: number; content: string } }) => {
          revisions.push({ revision: data.revision, content: data.content });
          return data;
        }),
      },
    };
    return {
      revisions,
      tx,
      prisma: {
        spaceMember: { findFirst: vi.fn(async () => ({ id: "membership-1" })) },
        bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
        $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
      } as never,
    };
  }

  const append = (content: string) =>
    ({ scope: "bot", botId: "bot-1", path: "MEMORY.md", content, mode: "append" }) as const;

  it("creates the document on the first append", async () => {
    const db = stubPrisma();
    const store = new MarkdownMemoryStore(db.prisma);

    await expect(store.commit(append("- Prefers Rust"), context)).resolves.toMatchObject({
      revision: 1,
      content: "- Prefers Rust",
    });
    expect(db.revisions).toEqual([{ revision: 1, content: "- Prefers Rust" }]);
  });

  it("creates separate proposals instead of appending to an existing memory", async () => {
    const db = stubPrisma();
    const store = new MarkdownMemoryStore(db.prisma);

    await store.commit(append("- Prefers Rust"), context);
    const second = await store.commit(append("- Ships on Fridays"), context);

    expect(second.content).toBe("- Ships on Fridays");
    expect(second.revision).toBe(1);
    expect(db.revisions).toHaveLength(2);
  });

  it("does not alter an existing approved document", async () => {
    const db = stubPrisma({ content: "# Memory\n", revision: 4 });
    const store = new MarkdownMemoryStore(db.prisma);

    await expect(store.commit(append("- Prefers Rust"), context)).resolves.toMatchObject({
      revision: 1,
      content: "- Prefers Rust",
    });
  });

  it("replaces the whole document by default", async () => {
    const db = stubPrisma({ content: "old", revision: 1 });
    const store = new MarkdownMemoryStore(db.prisma);

    await expect(
      store.commit({ scope: "user", path: "MEMORY.md", content: "new" }, context),
    ).resolves.toMatchObject({ revision: 1, content: "new" });
  });

  it("appends onto the winning content when a conflicting attempt is retried", async () => {
    const db = stubPrisma({ content: "- Prefers Rust", revision: 1 });
    let attempts = 0;
    const prisma = {
      spaceMember: { findFirst: vi.fn(async () => ({ id: "membership-1" })) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
      $transaction: async (run: (client: unknown) => Promise<unknown>) => {
        attempts += 1;
        if (attempts === 1) {
          // A concurrent append commits first; this attempt loses the serialization race.
          db.tx.memoryDocument.update({
            data: { content: "- Prefers Rust\n- Ships on Fridays", revision: 2 },
          } as never);
          throw Object.assign(new Error("write conflict"), { code: "P2034" });
        }
        return run(db.tx);
      },
    } as never;
    const store = new MarkdownMemoryStore(prisma);

    await expect(store.commit(append("- Uses pnpm"), context)).resolves.toMatchObject({
      revision: 1,
      content: "- Uses pnpm",
    });
    expect(attempts).toBe(2);
  });
});
