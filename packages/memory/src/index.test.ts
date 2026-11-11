import type { AdapterContext } from "@tangow/adapter-kit";
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
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });
});

describe("append commits", () => {
  /** Minimal Prisma stub: one document row, transactions run inline. */
  function stubPrisma(seed?: { content: string; revision: number }) {
    let row = seed ? { id: "memory-1", path: "MEMORY.md", ...seed } : undefined;
    const revisions: Array<{ revision: number; content: string }> = [];
    const tx = {
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

  it("keeps both facts, in call order, across two appends", async () => {
    const db = stubPrisma();
    const store = new MarkdownMemoryStore(db.prisma);

    await store.commit(append("- Prefers Rust"), context);
    const second = await store.commit(append("- Ships on Fridays"), context);

    expect(second.content).toBe("- Prefers Rust\n- Ships on Fridays");
    expect(second.revision).toBe(2);
    expect(db.revisions).toHaveLength(2);
  });

  it("does not double the separator when the document already ends with a newline", async () => {
    const db = stubPrisma({ content: "# Memory\n", revision: 4 });
    const store = new MarkdownMemoryStore(db.prisma);

    await expect(store.commit(append("- Prefers Rust"), context)).resolves.toMatchObject({
      revision: 5,
      content: "# Memory\n- Prefers Rust",
    });
  });

  it("replaces the whole document by default", async () => {
    const db = stubPrisma({ content: "old", revision: 1 });
    const store = new MarkdownMemoryStore(db.prisma);

    await expect(
      store.commit({ scope: "user", path: "MEMORY.md", content: "new" }, context),
    ).resolves.toMatchObject({ revision: 2, content: "new" });
  });

  it("appends onto the winning content when a conflicting attempt is retried", async () => {
    const db = stubPrisma({ content: "- Prefers Rust", revision: 1 });
    let attempts = 0;
    const prisma = {
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
      revision: 3,
      content: "- Prefers Rust\n- Ships on Fridays\n- Uses pnpm",
    });
    expect(attempts).toBe(2);
  });
});
