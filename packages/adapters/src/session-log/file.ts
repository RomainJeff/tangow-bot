import {
  appendFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { NewSession, SessionEntryDraft, SessionHead, SessionLog } from "@rakazo/adapter-kit";
import {
  nextSessionEntry,
  SessionAppendError,
  SessionReadError,
  sessionEntryNonce,
} from "@rakazo/adapter-kit";
import type { EntryId, SessionEntry } from "@rakazo/contracts";
import { SessionId } from "@rakazo/contracts";
import type { TailSource } from "@rakazo/core";
import { decodeEntries, readTailFromEnd, SessionEntryMissingParentError } from "@rakazo/core";

const TAIL_CHUNK_BYTES = 64 * 1024;
const FILE_SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface SessionFile {
  head: SessionHead | null;
  ids: Set<string>;
  delivered: Map<string, SessionEntry>;
}

/**
 * One `<root>/sessions/<sessionId>.jsonl` per session, for export, import, fixtures and a single
 * process install. Single process only: appends serialize through an in-memory lock per session and
 * the writer caches each session's head, so one instance owns a root. `readRun` scans every file.
 */
export class FileSessionLog implements SessionLog<undefined> {
  private readonly sessions = new Map<SessionId, SessionFile>();
  private readonly locks = new Map<SessionId, Promise<void>>();

  constructor(private readonly root: string) {}

  async createSession(_tx: undefined, session: NewSession): Promise<SessionId> {
    const id = session.kind === "thread" ? await this.claimThread(session) : session.id;
    const file = this.fileOf(id);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, "");
    return id;
  }

  append(_tx: undefined, draft: SessionEntryDraft): Promise<SessionEntry> {
    return this.locked(draft.sessionId, async () => {
      const session = await this.load(draft.sessionId);
      const nonce = sessionEntryNonce(draft);
      const delivered = nonce === undefined ? undefined : session.delivered.get(nonce);
      if (delivered) return delivered;
      if (draft.type === "rewind" && !session.ids.has(draft.parentId)) {
        throw new SessionAppendError(
          "missing_parent",
          `Rewind target ${draft.parentId} is not in session ${draft.sessionId}`,
        );
      }
      const entry = nextSessionEntry(draft, (session.head?.seq ?? -1) + 1, session.head);
      try {
        await appendFile(this.fileOf(entry.sessionId), `${JSON.stringify(entry)}\n`);
      } catch (error) {
        this.sessions.delete(entry.sessionId);
        throw error;
      }
      remember(session, entry);
      return entry;
    });
  }

  async readTail(sessionId: SessionId): Promise<SessionEntry[]> {
    const file = this.fileOf(sessionId);
    try {
      return await readTailFromEnd(() => openTail(file), TAIL_CHUNK_BYTES);
    } catch (error) {
      if (isMissing(error)) return [];
      if (error instanceof SessionEntryMissingParentError) {
        throw new SessionReadError(sessionId, error.parentId, { cause: error });
      }
      throw error;
    }
  }

  async readPage(
    sessionId: SessionId,
    { before, limit }: { before?: EntryId; limit: number },
  ): Promise<SessionEntry[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`limit must be a positive integer, got ${limit}`);
    }
    const entries = await this.readAll(sessionId);
    const byId = new Map<string, SessionEntry>(entries.map((entry) => [entry.id, entry]));
    const parentOf = (entry: SessionEntry | undefined) =>
      entry?.parentId ? byId.get(entry.parentId) : undefined;
    const page: SessionEntry[] = [];
    let cursor = before === undefined ? entries.at(-1) : parentOf(byId.get(before));
    while (cursor) {
      page.push(cursor);
      if (page.length === limit || cursor.parentId === null) break;
      const parent = byId.get(cursor.parentId);
      if (!parent) throw new SessionReadError(sessionId, cursor.parentId);
      cursor = parent;
    }
    return page.reverse();
  }

  async readRun(runId: string): Promise<SessionEntry[]> {
    const dir = path.join(this.root, "sessions");
    const names = await readdir(dir).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const entries = decodeEntries(await readFile(path.join(dir, name), "utf8"));
      const run = entries.filter((entry) => entry.runId === runId);
      if (run.length > 0) return run;
    }
    return [];
  }

  private async readAll(sessionId: SessionId): Promise<SessionEntry[]> {
    try {
      return decodeEntries(await readFile(this.fileOf(sessionId), "utf8"));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  /**
   * The session's state from its file, read once per instance. A final line a crash left without
   * its newline is ended when it is a valid entry and cut off when it is torn, so the next append
   * starts on a fresh line.
   */
  private async load(sessionId: SessionId): Promise<SessionFile> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const file = this.fileOf(sessionId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      throw new SessionAppendError("unknown_session", `Session ${sessionId} does not exist`);
    }
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    const entries = decodeEntries(complete);
    const fragment = text.slice(complete.length);
    if (fragment) {
      const [last] = decodeEntries(fragment);
      if (last) {
        entries.push(last);
        await appendFile(file, "\n");
      } else {
        await truncate(file, Buffer.byteLength(complete));
      }
    }
    const session: SessionFile = { head: null, ids: new Set(), delivered: new Map() };
    for (const entry of entries) remember(session, entry);
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * The thread's main session: the id in `<root>/threads/<threadId>`, written by the first claim.
   * A claim links a complete file into place, so a crash cannot leave a partial one.
   */
  private async claimThread(session: { id: SessionId; threadId: string }): Promise<SessionId> {
    const claim = path.join(this.root, "threads", safeName("Thread", session.threadId));
    const draft = `${claim}.${crypto.randomUUID()}`;
    await mkdir(path.dirname(claim), { recursive: true });
    await writeFile(draft, safeName("Session", session.id));
    try {
      await link(draft, claim);
      return session.id;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return SessionId.parse(await readFile(claim, "utf8"));
    } finally {
      await rm(draft, { force: true });
    }
  }

  private locked<T>(sessionId: SessionId, work: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(sessionId) ?? Promise.resolve()).then(work);
    this.locks.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private fileOf(sessionId: string): string {
    return path.join(this.root, "sessions", `${safeName("Session", sessionId)}.jsonl`);
  }
}

function remember(session: SessionFile, entry: SessionEntry): void {
  session.head = { id: entry.id, seq: entry.seq };
  session.ids.add(entry.id);
  const nonce = sessionEntryNonce(entry);
  if (nonce !== undefined) session.delivered.set(nonce, entry);
}

async function openTail(file: string): Promise<TailSource> {
  const handle = await open(file, "r");
  const { size } = await handle.stat();
  return {
    size,
    async read(position, length) {
      const bytes = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(bytes, filled, length - filled, position + filled);
        if (bytesRead === 0) throw new Error(`${file} ended before byte ${position + length}`);
        filled += bytesRead;
      }
      return bytes;
    },
    close: () => handle.close(),
  };
}

function safeName(kind: "Session" | "Thread", id: string): string {
  if (!FILE_SAFE_ID.test(id)) {
    throw new Error(`${kind} id ${JSON.stringify(id)} is not a safe file name`);
  }
  return id;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}
