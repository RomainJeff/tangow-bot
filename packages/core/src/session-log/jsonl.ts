import type { EntryId, SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";

export class SessionEntryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEntryDecodeError";
  }
}

export class SessionEntryMissingParentError extends SessionEntryDecodeError {
  constructor(
    readonly parentId: EntryId,
    location: string,
  ) {
    super(`Invalid session entry at ${location}: its parent ${parentId} is missing from the file`);
  }
}

/**
 * Random access to the bytes of one session's JSONL file, opened for a single read. Each `read`
 * returns a buffer the caller owns, never a reused one, because the reader keeps subarray views.
 */
export interface TailSource {
  readonly size: number;
  /** Resolves to exactly `length` bytes starting at `position`. */
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

const NEWLINE = 0x0a;

export function encodeEntries(entries: readonly SessionEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/**
 * Decode a whole session JSONL file. A final line without its newline is kept when it is a valid
 * entry and skipped as a torn append, a crash mid-write, when it is not. Any other line that is
 * not JSON or fails validation throws `SessionEntryDecodeError` with its line number.
 */
export function decodeEntries(text: string): SessionEntry[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    if (!line) return [];
    if (index === lines.length - 1) return finalEntry(line) ?? [];
    const location = `line ${index + 1}`;
    return [validateEntry(parseJson(line, location), location)];
  });
}

/**
 * A tail in seq order with the compaction it starts from moved to the front, so its summary comes
 * before the entries it kept, which are older than it.
 */
export function compactionFirst(tail: SessionEntry[]): SessionEntry[] {
  const at = tail.findLastIndex((entry) => entry.type === "compaction");
  return at <= 0 ? tail : [tail[at]!, ...tail.slice(0, at), ...tail.slice(at + 1)];
}

/**
 * Read a session's tail from the end of its JSONL file: from the last line, follow `parentId`
 * backwards, skipping lines a rewind left off the chain, and stop at an entry with no parent or,
 * once a `compaction` entry was met, at the last entry its summary covers, or after `maxEntries`.
 * Reads `chunkSize` bytes at a time, so a long session costs about the bytes since that entry.
 * Returns the tail in the `compactionFirst` order.
 *
 * A final line without its newline follows the `decodeEntries` rule. Any other line read that is
 * not JSON and a chain entry that fails validation throw `SessionEntryDecodeError` with the line,
 * and a parent missing from the file throws its `SessionEntryMissingParentError` subclass.
 */
export async function readTailFromEnd(
  open: () => Promise<TailSource>,
  chunkSize: number,
  maxEntries = Number.POSITIVE_INFINITY,
): Promise<SessionEntry[]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const source = await open();
  try {
    const decoder = new TextDecoder();
    const chain: SessionEntry[] = [];
    let coveredUpToSeq = -1;
    let wanted: EntryId | null | undefined;
    let wantedBy = "";
    let linesFromEnd = 0;
    let afterLastNewline = true;
    const visit = (bytes: Uint8Array): boolean => {
      const final = afterLastNewline;
      afterLastNewline = false;
      if (bytes.length === 0) return false;
      linesFromEnd += 1;
      const location = `line ${linesFromEnd} from the end`;
      const line = decoder.decode(bytes);
      let entry: SessionEntry | undefined;
      if (final) {
        entry = finalEntry(line);
        if (!entry) return false;
      } else {
        const json = parseJson(line, location);
        if (wanted !== undefined && idOf(json) !== wanted) return false;
        entry = validateEntry(json, location);
      }
      if (entry.seq <= coveredUpToSeq) return true;
      chain.push(entry);
      if (coveredUpToSeq < 0 && entry.type === "compaction") {
        coveredUpToSeq = entry.payload.coveredUpToSeq;
      }
      wanted = entry.parentId;
      wantedBy = location;
      return wanted === null || chain.length === maxEntries;
    };
    let pieces: Uint8Array[] = [];
    let end = source.size;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const chunk = await source.read(start, end - start);
      end = start;
      let lineEnd = chunk.length;
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== NEWLINE) continue;
        if (visit(concat([chunk.subarray(index + 1, lineEnd), ...pieces.toReversed()]))) {
          return compactionFirst(chain.reverse());
        }
        pieces = [];
        lineEnd = index;
      }
      pieces.push(chunk.subarray(0, lineEnd));
    }
    if (visit(concat(pieces.toReversed())) || !wanted) return compactionFirst(chain.reverse());
    throw new SessionEntryMissingParentError(wanted, wantedBy);
  } finally {
    await source.close();
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function parseJson(line: string, location: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SessionEntryDecodeError(`Invalid session entry at ${location}: not JSON (${reason})`);
  }
}

function validateEntry(json: unknown, location: string): SessionEntry {
  const parsed = SessionEntrySchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(entry)"}: ${issue.message}`)
    .join("; ");
  throw new SessionEntryDecodeError(`Invalid session entry at ${location}: ${issues}`);
}

function finalEntry(line: string): SessionEntry | undefined {
  try {
    return SessionEntrySchema.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

function idOf(json: unknown): unknown {
  return json && typeof json === "object" && "id" in json ? json.id : undefined;
}
