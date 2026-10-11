import { vi } from "vitest";

export function stubbedDbSessions() {
  return {
    appendSessionEntryInTransaction: vi.fn(async (_tx: unknown, draft: unknown) => draft),
    appendCardStateInTransaction: vi.fn(async (_tx: unknown, draft: unknown) => draft),
    appendRunBlocksInTransaction: vi.fn(async () => undefined),
    appendRunFinishedInTransaction: vi.fn(async () => undefined),
    appendRewindInTransaction: vi.fn(async () => undefined),
    appendComputerControlInTransaction: vi.fn(async () => undefined),
    createSessionInTransaction: vi.fn(async (_tx: unknown, session: { id: string }) => session.id),
    historyGeneration: vi.fn(async () => 0),
    threadOfSession: vi.fn(async (): Promise<string | null> => null),
    sessionEntryFromRow: vi.fn((row: unknown) => row),
  };
}
