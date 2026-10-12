import { vi } from "vitest";
import type * as Sessions from "./sessions.js";

/** The session module with its writers stubbed; its readers run against the fake client. */
export async function stubbedDbSessions() {
  return {
    ...(await vi.importActual<typeof Sessions>("./sessions.js")),
    appendSessionEntryInTransaction: vi.fn(async (_tx: unknown, draft: object) => ({
      id: "entry-new",
      ...draft,
    })),
    appendCardStateInTransaction: vi.fn(async (_tx: unknown, draft: unknown) => draft),
    appendRunBlocksInTransaction: vi.fn(async () => true),
    appendRunFinishedInTransaction: vi.fn(async () => undefined),
    appendRewindInTransaction: vi.fn(async () => undefined),
    appendComputerControlInTransaction: vi.fn(async () => undefined),
    createSessionInTransaction: vi.fn(async (_tx: unknown, session: { id: string }) => session.id),
    historyGeneration: vi.fn(async () => 0),
    threadOfSession: vi.fn(async (): Promise<string | null> => null),
  };
}
