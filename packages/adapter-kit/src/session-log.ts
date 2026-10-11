import type { EntryId, SessionEntry, SessionId } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";

type Draft<E> = E extends { type: "rewind" }
  ? Omit<E, "id" | "seq" | "ts"> & { id?: EntryId; ts?: string }
  : Omit<E, "id" | "seq" | "parentId" | "ts"> & { id?: EntryId; ts?: string };

/**
 * An entry as a writer hands it to `SessionLog.append`. The log assigns `seq` and makes the
 * session's head the parent, except that a rewind names its target as `parentId` and a clear has
 * no parent. `id` defaults to a new uuid and `ts` to now. A thread's feed shows the entry under its
 * `botId`, else under `feedBotId`, which the entry does not keep.
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
    };

/** The session's entry with the highest seq, as stored; `nextSessionEntry` validates what it becomes. */
export type SessionHead = { id: string; seq: number };

export type SessionAppendRefusal =
  | "unknown_session"
  | "missing_parent"
  | "stale_compaction"
  | "no_feed_bot";

export class SessionAppendError extends Error {
  constructor(
    readonly reason: SessionAppendRefusal,
    message: string,
  ) {
    super(message);
    this.name = "SessionAppendError";
  }
}

/** A read found the chain broken: an entry's parent is not in the session. */
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
  if (draft.type === "compaction" && draft.payload.coveredUpToSeq !== head?.seq) {
    throw new SessionAppendError(
      "stale_compaction",
      `Compaction covers up to seq ${draft.payload.coveredUpToSeq} but the head of session ${draft.sessionId} is at seq ${head?.seq ?? "none"}`,
    );
  }
  return SessionEntrySchema.parse({
    ...draft,
    id: draft.id ?? crypto.randomUUID(),
    seq,
    parentId:
      draft.type === "rewind" ? draft.parentId : draft.type === "clear" ? null : (head?.id ?? null),
    ts: new Date(draft.ts ?? Date.now()).toISOString(),
  });
}
