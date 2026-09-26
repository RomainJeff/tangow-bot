import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { memoryManifestStillAuthorized } from "./executor.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

describe("memory revocation guard", () => {
  it("fails closed when a document is withdrawn after it entered a model manifest", async () => {
    const read = vi.fn(async () => ({ documents: [] }));
    const store = { read } as unknown as MemoryStore;

    await expect(
      memoryManifestStillAuthorized(store, "bot-1", context, [
        { documentId: "memory-1", revision: 2, accessVersion: 4 },
      ]),
    ).resolves.toBe(false);
  });

  it("requires the exact canonical revision and access version", async () => {
    const store = {
      read: vi.fn(async () => ({
        documents: [
          { id: "memory-1", path: "memory.md", content: "active", revision: 2, accessVersion: 4 },
        ],
      })),
    } as unknown as MemoryStore;

    await expect(
      memoryManifestStillAuthorized(store, "bot-1", context, [
        { documentId: "memory-1", revision: 2, accessVersion: 4 },
      ]),
    ).resolves.toBe(true);
    await expect(
      memoryManifestStillAuthorized(store, "bot-1", context, [
        { documentId: "memory-1", revision: 2, accessVersion: 5 },
      ]),
    ).resolves.toBe(false);
  });
});
