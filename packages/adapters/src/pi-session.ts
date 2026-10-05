import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getLogger } from "@rakazo/logging";

export const PI_SESSION_RETENTION_DAYS = 30;
export const PI_SESSION_MAX_FILES_PER_BOT = 100;

const PI_SESSION_RETENTION_MS = PI_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function sessionScopeSegment(value: string, label: string): string {
  if (!value) throw new Error(`${label} must be non-empty`);
  return Buffer.from(value, "utf8").toString("base64url");
}

export function piSessionUserRoot(sessionsRoot: string, userId: string): string {
  return path.join(path.resolve(sessionsRoot), sessionScopeSegment(userId, "userId"));
}

export function piSessionBotRoot(sessionsRoot: string, userId: string, botId: string): string {
  return path.join(piSessionUserRoot(sessionsRoot, userId), sessionScopeSegment(botId, "botId"));
}

export function piSessionsRoot(dataDir: string): string {
  return path.resolve(dataDir, "pi-sessions");
}

/** Opt-in only. Hosted multi-tenant DATA_DIR transcripts are unencrypted. */
export function isPiSessionRecordingEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.PI_SESSION_RECORDING === "true";
}

/** Returns the Pi JSONL session root when recording is enabled; otherwise undefined. */
export function resolvePiSessionRoot(
  dataDir: string,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return isPiSessionRecordingEnabled(source) ? piSessionsRoot(dataDir) : undefined;
}

export async function removePiBotSessions(
  dataDir: string | undefined,
  userId: string | undefined,
  botId: string,
): Promise<void> {
  if (!dataDir) return;
  if (!userId) throw new Error("userId is required to remove Pi bot sessions");
  await rm(piSessionBotRoot(piSessionsRoot(dataDir), userId, botId), {
    recursive: true,
    force: true,
  });
}

export async function removePiUserSessions(
  dataDir: string | undefined,
  userId: string,
): Promise<void> {
  if (!dataDir) return;
  await rm(piSessionUserRoot(piSessionsRoot(dataDir), userId), {
    recursive: true,
    force: true,
  });
}

export interface PiSessionRetentionOptions {
  now?: number;
  maxAgeMs?: number;
  maxFiles?: number;
}

interface PiSessionFile {
  path: string;
  mtimeMs: number;
}

async function collectPiSessionFiles(directory: string, files: PiSessionFile[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectPiSessionFiles(filePath, files);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      const details = await stat(filePath);
      files.push({ path: filePath, mtimeMs: details.mtimeMs });
    }),
  );
}

export async function prunePiSessionFiles(
  root: string,
  options: PiSessionRetentionOptions = {},
): Promise<void> {
  const maxAgeMs = options.maxAgeMs ?? PI_SESSION_RETENTION_MS;
  const maxFiles = options.maxFiles ?? PI_SESSION_MAX_FILES_PER_BOT;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError("maxAgeMs must be a non-negative finite number");
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new RangeError("maxFiles must be a positive integer");
  }

  const files: PiSessionFile[] = [];
  await collectPiSessionFiles(root, files);
  const cutoff = (options.now ?? Date.now()) - maxAgeMs;
  const expired = files.filter((file) => file.mtimeMs < cutoff);
  const retained = files.filter((file) => file.mtimeMs >= cutoff);
  retained.sort((left, right) => right.mtimeMs - left.mtimeMs);

  await Promise.all(
    [...expired, ...retained.slice(maxFiles)].map((file) => rm(file.path, { force: true })),
  );
}

export interface PiSessionStart {
  runId: string;
  threadId: string;
  botId: string;
  userId: string;
  traceId?: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  systemPrompt: string;
  initialMessages: readonly AgentMessage[];
}

export interface PiSessionHandle {
  appendMessage(message: AgentMessage): Promise<void>;
}

export interface PiSessionRecorder {
  start(input: PiSessionStart): Promise<PiSessionHandle>;
}

/**
 * Appends the low-level Agent transcript to one JSONL file per run: a session header, then
 * entries. This is deliberately a recorder only: Rakazo remains responsible for running
 * the agent and for its product history in Postgres.
 */
export class PiJsonlSessionRecorder implements PiSessionRecorder {
  private readonly cwd: string;
  private readonly sessionsRoot: string;

  constructor(sessionsRoot: string, cwd = process.cwd()) {
    this.cwd = path.resolve(cwd);
    this.sessionsRoot = path.resolve(sessionsRoot);
  }

  async start(input: PiSessionStart): Promise<PiSessionHandle> {
    const sessionsRoot = piSessionBotRoot(this.sessionsRoot, input.userId, input.botId);
    await mkdir(sessionsRoot, { recursive: true });
    const file = path.join(sessionsRoot, `${sessionScopeSegment(input.runId, "runId")}.jsonl`);
    try {
      await prunePiSessionFiles(sessionsRoot);
    } catch (error) {
      getLogger().warn("Pi session retention cleanup failed", {
        userId: input.userId,
        botId: input.botId,
        error,
      });
    }
    const handle = new BestEffortPiSession(file, input.runId);

    await handle.append({
      kind: "session",
      id: input.runId,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
    });
    await handle.append({
      kind: "entry",
      type: "custom",
      customType: "rakazo_context",
      data: {
        rakazoUserId: input.userId,
        rakazoBotId: input.botId,
        rakazoRunId: input.runId,
        rakazoThreadId: input.threadId,
        ...(input.traceId ? { rakazoTraceId: input.traceId } : {}),
        model: input.model,
        provider: input.provider,
        thinkingLevel: input.thinkingLevel,
        systemPrompt: input.systemPrompt,
      },
    });
    for (const message of input.initialMessages) {
      await handle.appendMessage(message);
    }

    return handle;
  }
}

class BestEffortPiSession implements PiSessionHandle {
  private failureLogged = false;

  constructor(
    private readonly file: string,
    private readonly runId: string,
  ) {}

  async appendMessage(message: AgentMessage): Promise<void> {
    await this.append({ kind: "entry", type: "message", message });
  }

  async append(record: Record<string, unknown>): Promise<void> {
    try {
      await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      this.logFailure(String(record.kind), error);
    }
  }

  private logFailure(kind: string, error: unknown): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    getLogger().warn("Pi session recording failed", {
      kind,
      runId: this.runId,
      error,
    });
  }
}
