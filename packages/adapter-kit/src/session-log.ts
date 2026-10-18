import type { EntryId, SessionEntry, SessionId } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";

type Draft<E> = E extends { type: "rewind" | "compaction" }
  ? Omit<E, "id" | "seq" | "ts"> & { id?: EntryId; ts?: string }
  : Omit<E, "id" | "seq" | "parentId" | "ts"> & { id?: EntryId; ts?: string };

/**
 * An entry as a writer hands it to `SessionLog.append`. The log assigns `seq` and makes the
 * session's head the parent, except that a rewind names its target as `parentId`, a compaction
 * names the head it summarized up to as `parentId`, and a clear has no parent. `id` defaults to a
 * new uuid and `ts` to now. A thread's feed shows the entry under its `botId`, else under
 * `feedBotId`, which the entry does not keep.
 */
export type SessionEntryDraft = Draft<SessionEntry> & { feedBotId?: string };

export type NewSession =
  | { kind: "thread"; id: SessionId; spaceId: string; threadId: string }
  | {
      kind: "subagent";
      id: SessionId;
      spaceId: string;
      parentSessionId: SessionId;
      /** The `tool.call` entry in the parent session that launched the subagent. */
      parentEntryId: EntryId;
    }
  | {
      kind: "interactive";
      id: SessionId;
      spaceId: string;
      parentSessionId: SessionId;
      parentEntryId: EntryId;
    }
  | {
      kind: "routine";
      id: SessionId;
      spaceId: string;
      /** The thread's main session, which the routine run reports to. */
      parentSessionId: SessionId;
    };

/** The session's entry with the highest seq, as stored; `nextSessionEntry` validates what it becomes. */
export type SessionHead = { id: string; seq: number };

export type SessionAppendRefusal =
  | "unknown_session"
  | "missing_parent"
  | "stale_compaction"
  | "no_feed_bot"
  | "run_finished";

export type RunSearchInput = {
  scope: {
    runId: string;
    botId: string;
    sessionId: SessionId;
    /** Caller-derived owner, conversation, launch ancestry and chain revision binding. */
    authorizationKey: string;
    /** The authorized main session when this run writes its trace in a child. */
    raisedSessionId?: SessionId;
  };
  query: string;
  cursor?: string;
  /** Can lower the fixed response ceiling, including cursor and envelope. */
  maxBytes?: number;
  /** Applied to each complete size-bounded field before matching and clipping. */
  redaction: { redact(text: string): string };
};

export class SessionAppendError extends Error {
  constructor(
    readonly reason: SessionAppendRefusal,
    message: string,
  ) {
    super(message);
    this.name = "SessionAppendError";
  }
}

export class SessionReadError extends Error {
  readonly reason = "missing_parent";

  constructor(
    readonly sessionId: SessionId,
    readonly parentId: EntryId,
    options?: ErrorOptions,
  ) {
    super(`Session ${sessionId} has an entry whose parent ${parentId} is missing`, options);
    this.name = "SessionReadError";
  }
}

/** Guards the entry counts a read takes, `readPage`'s `limit` and `readTail`'s `maxEntries`. */
export function assertEntryCount(name: string, count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${count}`);
  }
}

/** The redelivery key of the entry types that carry one. */
export function sessionEntryNonce(entry: SessionEntryDraft | SessionEntry): string | undefined {
  return entry.type === "user.message" || entry.type === "bot.message.received"
    ? entry.payload.clientNonce
    : undefined;
}

/**
 * The entry a draft becomes at `seq` on top of `head`, validated. Every backend appends through it,
 * so the parent rule and the compaction rule have one definition. The caller has already checked
 * that a rewind's target is in the session.
 */
export function nextSessionEntry(
  draft: SessionEntryDraft,
  seq: number,
  head: SessionHead | null,
): SessionEntry {
  if (draft.type === "compaction" && draft.parentId !== head?.id) {
    throw new SessionAppendError(
      "stale_compaction",
      `Compaction was built on entry ${draft.parentId} but the head of session ${draft.sessionId} is ${head?.id ?? "none"}`,
    );
  }
  return SessionEntrySchema.parse({
    ...draft,
    id: draft.id ?? crypto.randomUUID(),
    seq,
    parentId:
      draft.type === "rewind" || draft.type === "compaction"
        ? draft.parentId
        : draft.type === "clear"
          ? null
          : (head?.id ?? null),
    ts: new Date(draft.ts ?? Date.now()).toISOString(),
  });
}
