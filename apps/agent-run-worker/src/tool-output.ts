import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { WORKER_LIMITS } from "@tangow/adapters/runtime-worker/wire";

/** A command's output for the model; `totalBytes` counts everything, including what was cut. */
export type CommandOutput = {
  text: string;
  isError: boolean;
  truncated: boolean;
  totalBytes: number;
  /** Full output on the mount, when it was cut for the model. */
  spoolPath?: string;
};

const MARKER_ROOM_CHARS = 256;
const MARKER_ROOM_LINES = 4;
// Enough raw bytes for either half of the model text, whatever the encoding.
const KEEP_BYTES = WORKER_LIMITS.localOutputModelChars * 4;

/** Everything a command prints: counted in full, spooled up to a cap, head and tail kept in memory. */
function outputCapture(spoolPath: string) {
  const spool = createWriteStream(spoolPath, { flags: "wx", mode: 0o600 });
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  let spooled = 0;
  return {
    write(chunk: Buffer) {
      totalBytes += chunk.length;
      if (head.length < KEEP_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, KEEP_BYTES - head.length)]);
      }
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > KEEP_BYTES) tail = tail.subarray(tail.length - KEEP_BYTES);
      if (spooled < WORKER_LIMITS.localOutputSpoolBytes) {
        const part = chunk.subarray(0, WORKER_LIMITS.localOutputSpoolBytes - spooled);
        spooled += part.length;
        spool.write(part);
      }
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        spool.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      return { head: head.toString(), tail: tail.toString(), totalBytes, spooled };
    },
  };
}

/** The model sees the head and the tail of a long output, and where the whole of it is. */
function modelText(
  captured: { head: string; tail: string; totalBytes: number; spooled: number },
  spoolPath: string,
  status = "",
): { text: string; truncated: boolean } {
  const { localOutputModelChars: maxChars, localOutputModelLines: maxLines } = WORKER_LIMITS;
  const lines = captured.head.split("\n");
  if (
    captured.totalBytes <= KEEP_BYTES &&
    captured.head.length <= maxChars &&
    lines.length <= maxLines
  ) {
    return { text: captured.head, truncated: false };
  }
  const halfChars = Math.floor((maxChars - MARKER_ROOM_CHARS) / 2);
  const halfLines = Math.floor((maxLines - MARKER_ROOM_LINES) / 2);
  const head = lines.slice(0, halfLines).join("\n").slice(0, halfChars);
  const tail = captured.tail.split("\n").slice(-halfLines).join("\n").slice(-halfChars);
  const kept =
    captured.spooled < captured.totalBytes
      ? `its first ${captured.spooled} bytes are in`
      : "it is in";
  const marker = `[output truncated: ${captured.totalBytes} bytes in total, ${kept} ${spoolPath}]`;
  return { text: `${head}\n\n${marker}${status ? `\n${status}` : ""}\n\n${tail}`, truncated: true };
}

const SPOOL_FILE = /^\.rakazo-bash-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.log$/;
/** Spool files of commands still running in this process: never pruned. */
const spooling = new Set<string>();
let pruning = Promise.resolve();

/**
 * Makes room for one more spool file under the cap, oldest first, and claims its path. Calls run
 * one at a time, so concurrent commands do not overshoot the cap. Other files are left alone.
 */
function claimSpool(spoolDir: string): Promise<string> {
  const claimed = pruning.then(async () => {
    const names = (await readdir(spoolDir)).filter((name) => SPOOL_FILE.test(name));
    const excess = names.length - (WORKER_LIMITS.localOutputSpoolFiles - 1);
    if (excess > 0) {
      const aged = await Promise.all(
        names
          .map((name) => path.join(spoolDir, name))
          .filter((file) => !spooling.has(file))
          .map(async (file) => {
            const info = await stat(file).catch(() => null);
            return { file, mtimeMs: info?.mtimeMs ?? 0 };
          }),
      );
      aged.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
      await Promise.all(aged.slice(0, excess).map(({ file }) => rm(file, { force: true })));
    }
    const spoolPath = path.join(spoolDir, `.rakazo-bash-${randomUUID()}.log`);
    spooling.add(spoolPath);
    return spoolPath;
  });
  pruning = claimed.then(
    () => undefined,
    () => undefined,
  );
  return claimed;
}

/** Claims bounded storage before a command runs, then finishes its output for the model. */
export async function captureToolOutput(spoolDir: string) {
  await mkdir(spoolDir, { recursive: true });
  const spoolPath = await claimSpool(spoolDir);
  const capture = outputCapture(spoolPath);
  let streamed = false;
  return {
    write(data: Buffer) {
      streamed = true;
      capture.write(data);
    },
    async finish(text: string, isError: boolean): Promise<CommandOutput> {
      try {
        if (!streamed) capture.write(Buffer.from(text));
        const captured = await capture.close();
        const status = streamed
          ? text.match(
              /(?:^|\n)(Command (?:exited with code \d+|timed out after [^\n]+|aborted))$/,
            )?.[1]
          : undefined;
        const bounded = modelText(captured, spoolPath, status);
        if (!bounded.truncated) await rm(spoolPath, { force: true });
        return {
          ...bounded,
          // Preserve the native tool's status text when its raw stream fits.
          text:
            !bounded.truncated &&
            text.length <= WORKER_LIMITS.localOutputModelChars &&
            text.split("\n").length <= WORKER_LIMITS.localOutputModelLines
              ? text
              : bounded.text.replace(/\n$/, ""),
          isError,
          totalBytes: captured.totalBytes,
          ...(bounded.truncated ? { spoolPath } : {}),
        };
      } finally {
        spooling.delete(spoolPath);
      }
    },
  };
}
