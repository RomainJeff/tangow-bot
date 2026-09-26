import type { AdapterContext, MemorySnapshot, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { loadAgentMemoryContext, loadAgentMemoryDataContext } from "./memory-context.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

describe("agent memory context", () => {
  it("loads bot and user memory and renders newest revisions first", async () => {
    const read = vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
      snapshot(
        scope === "bot"
          ? [document("bot-old", "bot.md", "bot fact", 2, "2026-08-14T12:00:00.000Z")]
          : [document("user-new", "profile.md", "user fact", 1, "2026-08-15T12:00:00.000Z")],
      ),
    );

    const result = await loadAgentMemoryContext(storeWith(read), "bot-1", context);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith({ scope: "bot", botId: "bot-1" }, context);
    expect(read).toHaveBeenCalledWith({ scope: "user" }, context);
    expect(result).toContain("background data");
    expect(result).toContain("Active does not mean factually verified");
    expect(result).toContain("## user: profile.md (revision 1)\nuser fact");
    expect(result).toContain("## bot: bot.md (revision 2)\nbot fact");
    expect(result!.indexOf("user fact")).toBeLessThan(result!.indexOf("bot fact"));
  });

  it("caps the complete memory block without splitting UTF-8 characters", async () => {
    const read = vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
      snapshot(
        scope === "bot"
          ? [document("new", "new.md", "🙂".repeat(200), 1, "2026-08-15T12:00:00.000Z")]
          : [document("old", "old.md", "must not fit", 1, "2026-08-14T12:00:00.000Z")],
      ),
    );

    const result = await loadAgentMemoryContext(storeWith(read), "bot-1", context, 300);

    expect(Buffer.byteLength(result ?? "", "utf8")).toBeLessThanOrEqual(300);
    expect(result).toContain("## bot: new.md");
    expect(result).not.toContain("old.md");
    expect(result).not.toContain("�");
    expect(result?.endsWith("</durable_memory>")).toBe(true);
  });

  it("omits the memory block when neither scope has documents", async () => {
    const read = vi.fn(async () => snapshot([]));

    await expect(
      loadAgentMemoryContext(storeWith(read), "bot-1", context),
    ).resolves.toBeUndefined();
  });

  it("omits memory when the budget cannot fit its data boundary", async () => {
    const read = vi.fn(async () =>
      snapshot([document("one", "fact.md", "fact", 1, "2026-09-24T00:00:00Z")]),
    );
    await expect(
      loadAgentMemoryContext(storeWith(read), "bot-1", context, 20),
    ).resolves.toBeUndefined();
  });

  it("escapes memory text and keeps canonical revision identifiers out of the body", async () => {
    const read = vi.fn(async () =>
      snapshot([document("doc-1", "MEMORY.md", "<ignore> & keep", 3, "2026-08-15T12:00:00.000Z")]),
    );

    const result = await loadAgentMemoryContext(storeWith(read), "bot-1", context);

    expect(result).toContain("&lt;ignore&gt; &amp; keep");
    expect(result).not.toContain("<ignore>");
  });

  it("returns a text-free revision manifest for the supplied context", async () => {
    const read = vi.fn(async () =>
      snapshot([
        {
          ...document("doc-1", "MEMORY.md", "private body", 3, "2026-08-15T12:00:00.000Z"),
          accessVersion: 7,
        },
      ]),
    );

    const result = await loadAgentMemoryDataContext(storeWith(read), "bot-1", context);

    expect(result?.manifest).toEqual({
      documents: [
        {
          documentId: "doc-1",
          revision: 3,
          accessVersion: 7,
          scope: "bot",
          path: "MEMORY.md",
          reason: "recent_authorized",
          excerptBytes: 12,
        },
        {
          documentId: "doc-1",
          revision: 3,
          accessVersion: 7,
          scope: "user",
          path: "MEMORY.md",
          reason: "recent_authorized",
          excerptBytes: 12,
        },
      ],
    });
    expect(JSON.stringify(result?.manifest)).not.toContain("private body");
  });

  it("ranks authorized local lexical matches before recency and records the reason", async () => {
    const read = vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
      snapshot(
        scope === "bot"
          ? [document("bot-old", "relevant.md", "matched", 1, "2026-08-14T12:00:00.000Z")]
          : [document("user-new", "recent.md", "recent", 1, "2026-08-15T12:00:00.000Z")],
      ),
    );
    const store = {
      read,
      search: vi.fn(async () => [
        {
          documentId: "bot-old",
          path: "relevant.md",
          snippet: "matched",
          score: 1,
        },
      ]),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryDataContext(store, "bot-1", context, 32 * 1024, "match");

    expect(result?.content.indexOf("relevant.md")).toBeLessThan(
      result?.content.indexOf("recent.md") ?? 0,
    );
    expect(result?.manifest.documents[0]?.reason).toBe("local_lexical_match");
  });

  it("does not let an identically named document borrow another document's search score", async () => {
    const read = vi.fn(async ({ scope }: { scope: "bot" | "user" }) =>
      snapshot(
        scope === "bot"
          ? [document("bot-old", "MEMORY.md", "bot matched", 1, "2026-08-14T12:00:00.000Z")]
          : [document("user-new", "MEMORY.md", "user recent", 1, "2026-08-15T12:00:00.000Z")],
      ),
    );
    const store = {
      read,
      search: vi.fn(async () => [
        {
          documentId: "bot-old",
          path: "MEMORY.md",
          snippet: "bot matched",
          score: 1,
        },
      ]),
    } as unknown as MemoryStore;

    const result = await loadAgentMemoryDataContext(store, "bot-1", context, 32 * 1024, "matched");

    expect(result?.manifest.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: "bot-old",
          reason: "local_lexical_match",
        }),
        expect.objectContaining({
          documentId: "user-new",
          reason: "recent_authorized",
        }),
      ]),
    );
  });
});

function document(id: string, path: string, content: string, revision: number, updatedAt: string) {
  return { id, path, content, revision, updatedAt };
}

function snapshot(documents: MemorySnapshot["documents"]): MemorySnapshot {
  return { documents };
}

function storeWith(read: MemoryStore["read"]): MemoryStore {
  return { read } as MemoryStore;
}
