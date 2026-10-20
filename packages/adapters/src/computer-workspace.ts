import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, HomeStorage } from "@rakazo/contracts";
import type { HomePersistence } from "@rakazo/core";
import { homePersistence, parseScreenLeaseId } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { normalizeWorkspacePath, teamBotWorkspaceDirectory } from "./computer-support.js";
import type { LocalAgentHomeStore } from "./home.js";

export const PORTABLE_TRANSFER_BATCH_BYTES = 8 * 1024 * 1024;

const skippedBrowserProfileDirectories = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
]);
const skippedBrowserProfileFiles = new Set([
  "BrowserMetrics",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  ".parentlock",
  "lock",
]);

/** Excludes transient browser state that is unsafe or wasteful to restore. */
export function shouldSkipPortableWorkspaceFile(relative: string) {
  if (!relative.startsWith(".browser-profiles/")) return false;
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => skippedBrowserProfileDirectories.has(segment)) ||
    skippedBrowserProfileFiles.has(name)
  );
}

/** The stored computer fields that decide how its home persists. */
export type HomeRecord = { homeKey: string; homeStorage: string; homeRevision: string };

function persistenceOf(
  home: AgentHomeStore,
  record: HomeRecord,
  computer: ComputerRef,
): HomePersistence {
  return homePersistence({
    // computers_home_storage_check bounds the stored value.
    homeStorage: record.homeStorage as HomeStorage,
    computerKind: computer.kind,
    homeStore: home,
  });
}

export async function restoreComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  record: HomeRecord,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  if (persistenceOf(home, record, computer) !== "snapshot") return;
  await sandbox.importWorkspace(computer, home.exportHome(record.homeKey, context), context);
}

export async function ensureComputerWorkspaceLayout(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  scope: ComputerMode,
  botId: string | undefined,
  context: AdapterContext,
): Promise<void> {
  if (scope !== "team" || !botId) return;
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(botId)] },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(`Could not prepare Team Computer folders${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

/**
 * Keeps the files of a machine about to be discarded under a key of their own: they may be newer
 * than the live home or its volumes, which they must never overwrite.
 */
export async function archiveDiscardedWorkspace(
  home: AgentHomeStore,
  record: { homeKey: string },
  machineRef: string,
  files: AsyncIterable<PortableFile>,
  context: AdapterContext,
): Promise<void> {
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-discarded-"));
  try {
    let kept = 0;
    for await (const file of files) {
      await writePortableFile(staging, file);
      kept += 1;
    }
    if (kept > 0) await home.commit(`${record.homeKey}.discarded-${machineRef}`, staging, context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function checkpointComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  record: HomeRecord,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  const persistence = persistenceOf(home, record, computer);
  if (persistence === "volumes") return record.homeRevision;
  // Only the local-fs store is mounted: its directory is the Docker computer's disk.
  if (persistence === "mounted") return (home as LocalAgentHomeStore).revise(record.homeKey);
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-"));
  try {
    for await (const file of sandbox.exportWorkspace(computer, context)) {
      await writePortableFile(staging, file);
    }
    return await home.commit(record.homeKey, staging, context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Remote exports quiesce browsers, so a run must not checkpoint while peers are driving them. */
export async function checkpointRunComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: HomeRecord & { id: string; scope: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string | undefined> {
  if (computerRecord.scope !== "team" || computer.kind === "docker") {
    return checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  }
  const now = new Date();
  const ownLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : undefined;
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerRecord.id,
      state: "running",
      providerRef: computer.providerRef,
      executionLeases: {
        none: {
          expiresAt: { gt: now },
          ...(ownLease ? { NOT: { runId: ownLease.ownerId, fence: ownLease.fence } } : {}),
        },
      },
      OR: [
        { controlHolder: { not: "user" } },
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
        ...(context.botId ? [{ controlBotId: context.botId }] : []),
      ],
    },
    data: { state: "suspending", updatedAt: now },
  });
  // The last finishing run or the already scheduled idle job will checkpoint the shared home.
  if (claimed.count !== 1) return undefined;
  try {
    return await checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  } finally {
    await deps.prisma.computer.updateMany({
      where: { id: computerRecord.id, state: "suspending", providerRef: computer.providerRef },
      data: { state: "running" },
    });
  }
}

export async function checkpointAndRecordComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: HomeRecord & { id: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  const revision = await checkpointComputerWorkspace(
    deps.home,
    deps.sandbox,
    computerRecord,
    computer,
    context,
  );
  await deps.prisma.computer.updateMany({
    where: { id: computerRecord.id },
    data: { homeRevision: revision },
  });
  return revision;
}

async function writePortableFile(root: string, file: PortableFile) {
  const relative = normalizeWorkspacePath(file.path);
  if (!relative) throw new Error("Workspace snapshots cannot contain an empty file path");
  const target = path.resolve(root, relative);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Workspace snapshot path escapes its staging directory");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { mode: file.executable ? 0o700 : 0o600 });
}
