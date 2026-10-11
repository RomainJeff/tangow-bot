import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import type { EntryId, SessionEntry, SessionId } from "@rakazo/contracts";
import { vi } from "vitest";

export function hopEntryOf(blocks: unknown) {
  const carrier = (Array.isArray(blocks) ? blocks : []).find(
    (block: { kind?: string }) => block.kind === "bot_message_received" || block.kind === "handoff",
  ) as { kind: string; hop?: number } | undefined;
  if (!carrier) return null;
  return {
    type: carrier.kind === "handoff" ? "handoff" : "bot.message.received",
    payload: { hop: carrier.hop, exchangeId: "exchange-1" },
  };
}

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
      readTail: vi.fn(async (_sessionId: SessionId): Promise<SessionEntry[]> => []),
      readPage: vi.fn(async (_sessionId: SessionId, _page: unknown): Promise<SessionEntry[]> => []),
      readRun: vi.fn(async () => []),
      readEntry: vi.fn(
        async (_sessionId: SessionId, _entryId: EntryId): Promise<SessionEntry | undefined> =>
          undefined,
      ),
    },
    sessionEntry: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    /** A run with nothing logged and nothing that woke it, as the executor's opening read sees it. */
    queryRaw: vi.fn(async () => [
      { logged: null, carrierType: null, steered: false, routineName: null, spawnPromptId: null },
    ]),
  };
}
