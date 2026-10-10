import type { SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";

export class SessionEntryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEntryDecodeError";
  }
}

/** Random access to the bytes of one session's JSONL file, opened for a single read. */
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

export function decodeEntries(text: string): SessionEntry[] {
  return text.split("\n").flatMap((line, index) => {
    if (!line) return [];
    const location = `line ${index + 1}`;
    return [validateEntry(parseJson(line, location), location)];
  });
}

/**
 * Read a session's chain from the end of its JSONL file: from the last line, follow `parentId`
 * backwards, skipping lines a rewind left off the chain, and stop at the first `compaction` entry
 * or at an entry with no parent. Reads `chunkSize` bytes at a time, so a long session costs about
 * the bytes since its last compaction. Returns the chain oldest first.
 *
 * A file that does not end with a newline ends in a torn append, a crash mid-write, so its last
 * partial line is skipped. Any other line read that is not JSON, a chain entry that fails
 * validation, and a parent missing from the file throw `SessionEntryDecodeError` with the line.
 */
export async function readTailFromEnd(
  open: () => Promise<TailSource>,
  chunkSize: number,
): Promise<SessionEntry[]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const source = await open();
  try {
    const decoder = new TextDecoder();
    const chain: SessionEntry[] = [];
    let wanted: string | null | undefined;
    let wantedBy = "";
    let linesFromEnd = 0;
    let afterLastNewline = true;
    const visit = (bytes: Uint8Array): boolean => {
      const torn = afterLastNewline;
      afterLastNewline = false;
      if (bytes.length === 0) return false;
      linesFromEnd += 1;
      if (torn) return false;
      const location = `line ${linesFromEnd} from the end`;
      const json = parseJson(decoder.decode(bytes), location);
      if (wanted !== undefined && idOf(json) !== wanted) return false;
      const entry = validateEntry(json, location);
      chain.push(entry);
      wanted = entry.parentId;
      wantedBy = location;
      return entry.type === "compaction" || wanted === null;
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
          return chain.reverse();
        }
        pieces = [];
        lineEnd = index;
      }
      pieces.push(chunk.subarray(0, lineEnd));
    }
    if (visit(concat(pieces.toReversed())) || wanted === undefined) return chain.reverse();
    throw new SessionEntryDecodeError(
      `Invalid session entry at ${wantedBy}: its parent ${wanted} is missing from the file`,
    );
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

function idOf(json: unknown): unknown {
  return json && typeof json === "object" && "id" in json ? json.id : undefined;
}
