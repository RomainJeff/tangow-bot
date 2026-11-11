import type { SessionEntryDraft } from "@tangow/adapter-kit";
import type { EntryId, SessionEntry, SessionId } from "@tangow/contracts";
import { vi } from "vitest";

export function recordingSessionLog() {
  const drafts: SessionEntryDraft[] = [];
  return {
    drafts,
    sessionLog: {
      createSession: vi.fn(async (_tx: unknown, session: { id: string }) => session.id),
      append: vi.fn(async (_tx: unknown, draft: SessionEntryDraft) => {
        drafts.push(draft);
        return draft;
      }),
      readTail: vi.fn(
        async (
          _sessionId: SessionId,
          _options?: { maxEntries?: number },
        ): Promise<SessionEntry[]> => [],
      ),
      readPage: vi.fn(async (_sessionId: SessionId, _page: unknown): Promise<SessionEntry[]> => []),
      searchRun: vi.fn(async () => ({
        status: "ok" as const,
        hits: [],
        nextCursor: null,
        incomplete: false,
        limitations: [],
      })),
      readRun: vi.fn(async (_runId: string): Promise<SessionEntry[]> => []),
      readEntry: vi.fn(
        async (_sessionId: SessionId, _entryId: EntryId): Promise<SessionEntry | undefined> =>
          undefined,
      ),
    },
    sessionEntry: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    /**
     * A run with nothing logged and nothing that woke it, in a thread whose main session is
     * `session-main`, as the executor's opening reads see it. No bot's delivery woke it.
     */
    queryRaw: vi.fn(async (sql: TemplateStringsArray) =>
      sql.join("?").includes("'bot.message.received'")
        ? []
        : [
            {
              logged: null,
              carrierType: null,
              steered: false,
              routineName: null,
              spawnPromptId: null,
              sessionId: "session-main",
            },
          ],
    ),
  };
}
