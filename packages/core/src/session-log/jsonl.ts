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
 */
export async function readTailFromEnd(
  open: () => Promise<TailSource>,
  chunkSize: number,
): Promise<SessionEntry[]> {
  if (!(chunkSize > 0)) throw new RangeError(`chunkSize must be positive, got ${chunkSize}`);
  const source = await open();
  try {
    const decoder = new TextDecoder();
    const chain: SessionEntry[] = [];
    let wanted: string | null | undefined;
    let linesFromEnd = 0;
    const visit = (bytes: Uint8Array): boolean => {
      if (bytes.length === 0) return false;
      linesFromEnd += 1;
      const location = `line ${linesFromEnd} from the end`;
      const json = parseJson(decoder.decode(bytes), location);
      if (wanted !== undefined && idOf(json) !== wanted) return false;
      const entry = validateEntry(json, location);
      chain.push(entry);
      wanted = entry.parentId;
      return entry.type === "compaction" || wanted === null;
    };
    let carry = new Uint8Array(0);
    let end = source.size;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const chunk = await source.read(start, end - start);
      const buffer = new Uint8Array(chunk.length + carry.length);
      buffer.set(chunk);
      buffer.set(carry, chunk.length);
      end = start;
      let lineEnd = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] !== NEWLINE) continue;
        if (visit(buffer.subarray(index + 1, lineEnd))) return chain.reverse();
        lineEnd = index;
      }
      carry = buffer.slice(0, lineEnd);
    }
    if (visit(carry) || wanted === undefined) return chain.reverse();
    throw new SessionEntryDecodeError(`Session entry ${wanted} is missing from the file`);
  } finally {
    await source.close();
  }
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
