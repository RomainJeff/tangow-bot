import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { GuestMount, LocalToolOutput } from "@rakazo/adapter-kit";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import { FILE_TOOLS } from "./file-tools.js";

export interface LocalToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Where a tool keeps output too long for the model, on the guest disk. */
  spoolDir: string;
  botId: string;
  /** Prefix of every guest path the controller names. `/` in a VM. */
  root: string;
  /** The volumes `worker.start` mounted: the only places a write outlives the VM. */
  mounts: readonly GuestMount[];
}

export type LocalTool = (
  args: Record<string, unknown>,
  context: LocalToolContext,
) => Promise<LocalToolOutput>;

/** What a tool that prints text reports. */
export type CommandOutput = Extract<LocalToolOutput, { text: string }>;

const KILL_GRACE_MS = 2_000;
const MARKER_ROOM_CHARS = 256;
const MARKER_ROOM_LINES = 4;
// Enough raw bytes for either half of the model text, whatever the encoding.
const KEEP_BYTES = WORKER_LIMITS.localOutputModelChars * 4;

/** Everything a command prints: counted in full, spooled up to a cap, head and tail kept in memory. */
function outputCapture(spoolPath: string) {
  const spool = createWriteStream(spoolPath);
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
  return { text: `${head}\n\n${marker}\n\n${tail}`, truncated: true };
}

const SPOOL_FILE = /^bash-.+\.log$/;
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
    const spoolPath = path.join(spoolDir, `bash-${randomUUID()}.log`);
    spooling.add(spoolPath);
    return spoolPath;
  });
  pruning = claimed.then(
    () => undefined,
    () => undefined,
  );
  return claimed;
}

/** Kill the command's whole process group, forcefully after a grace period. */
function killGroup(pid: number | undefined, exited: Promise<unknown>) {
  if (pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // The group is already gone.
    }
  };
  signal("SIGTERM");
  const force = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
  void exited.finally(() => clearTimeout(force));
}

/** Runs in the workdir as its own process group, which an abort or a timeout kills whole. */
export async function bash(
  args: Record<string, unknown>,
  { cwd, signal, spoolDir }: LocalToolContext,
): Promise<CommandOutput> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) {
    return { text: "bash needs a command.", isError: true, truncated: false, totalBytes: 0 };
  }
  const timeoutSeconds = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : null;
  await mkdir(spoolDir, { recursive: true });
  const spoolPath = await claimSpool(spoolDir);
  try {
    return await runCommand(command, timeoutSeconds, spoolPath, cwd, signal);
  } finally {
    spooling.delete(spoolPath);
  }
}

async function runCommand(
  command: string,
  timeoutSeconds: number | null,
  spoolPath: string,
  cwd: string,
  signal: AbortSignal,
): Promise<CommandOutput> {
  const capture = outputCapture(spoolPath);
  const child = spawn("bash", ["-c", command], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", capture.write);
  child.stderr.on("data", capture.write);
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  let stopped: "aborted" | "timeout" | null = null;
  const stop = (reason: "aborted" | "timeout") => {
    stopped ??= reason;
    killGroup(child.pid, exited);
  };
  const onAbort = () => stop("aborted");
  if (signal.aborted) onAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutSeconds ? setTimeout(() => stop("timeout"), timeoutSeconds * 1000) : null;
  const exit = await exited;
  signal.removeEventListener("abort", onAbort);
  if (timer) clearTimeout(timer);

  const captured = await capture.close();
  const { text, truncated } = modelText(captured, spoolPath);
  if (!truncated) await rm(spoolPath, { force: true });
  const ending =
    stopped === "aborted"
      ? "Command aborted"
      : stopped === "timeout"
        ? `Command timed out after ${timeoutSeconds} seconds`
        : exit.error
          ? `Command could not start: ${exit.error.message}`
          : exit.code !== 0
            ? `Command exited with code ${exit.code}`
            : null;
  const body = text.replace(/\n$/, "") || (ending ? "" : "(no output)");
  return {
    text: ending ? `${body}${body ? "\n\n" : ""}${ending}` : body,
    isError: ending !== null,
    truncated,
    totalBytes: captured.totalBytes,
    ...(truncated ? { spoolPath } : {}),
  };
}

/** Tools the controller may place in the guest, by name. */
export const LOCAL_TOOLS: Readonly<Record<string, LocalTool>> = { bash, ...FILE_TOOLS };
