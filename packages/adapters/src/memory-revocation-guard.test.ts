import type { AdapterContext, MemoryStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { memoryGrant } from "./memory-context.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};
const entry = (accessVersion: number) => ({
  documentId: "memory-1",
  revision: 2,
  accessVersion,
  scope: "user" as const,
  path: "memory.md",
  reason: "recent_authorized" as const,
  excerptBytes: 6,
});
const storeWith = (documents: unknown[]) =>
  ({ read: vi.fn(async () => ({ documents })) }) as unknown as MemoryStore;

describe("memory grant", () => {
  it("requires the exact canonical revision and access version", async () => {
    const store = storeWith([
      { id: "memory-1", path: "memory.md", content: "active", revision: 2, accessVersion: 4 },
    ]);
    const grant = await memoryGrant(store, "bot-1", context);
    expect(grant.allows([entry(4)])).toBe(true);
    expect(grant.allows([entry(5)])).toBe(false);
    grant.add([entry(4)]);
    await expect(grant.isCurrent()).resolves.toBe(true);
    grant.add([entry(5)]);
    await expect(grant.isCurrent()).resolves.toBe(false);
  });

  it("treats a missing or malformed manifest as stale, and an empty one as no dependency", async () => {
    const grant = await memoryGrant(storeWith([]), "bot-1", context);
    expect(grant.allows(null)).toBe(false);
    expect(grant.allows([])).toBe(true);
    await expect(grant.isCurrent()).resolves.toBe(true);
    grant.add({ not: "a manifest" });
    await expect(grant.isCurrent()).resolves.toBe(false);
    expect(grant.toJSON()).toEqual([]);
  });
});
