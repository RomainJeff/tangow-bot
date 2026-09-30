import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const T01_REPLAY_STATE_VERSION = 1;

export type T01ReplayManifest = {
  version: typeof T01_REPLAY_STATE_VERSION;
  ownerId: string;
  expiresAt: number;
  resources: Partial<{ containerName: string; networkName: string; databaseContainerName: string }>;
  records: Partial<{ botId: string; computerId: string; spaceId: string; userId: string }>;
};

export type T01ReplaySecrets = {
  databaseUrl: string;
  supervisorToken: string;
  encryptionKey: string;
  testUserEmail: string;
  testUserPassword: string;
};

export type T01ReplayState = {
  directory: string;
  manifest: T01ReplayManifest;
  secrets: T01ReplaySecrets;
};

const manifestName = "manifest.json";
const secretsName = "secrets.json";

function privatePath(directory: string, filename: string): string {
  const resolvedDirectory = path.resolve(directory);
  const candidate = path.resolve(resolvedDirectory, filename);
  if (!candidate.startsWith(`${resolvedDirectory}${path.sep}`))
    throw new Error("T01 replay state path escapes its private directory.");
  return candidate;
}

async function assertPrivateFile(filename: string): Promise<void> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("T01 replay state is not private.");
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("T01 replay state directory is not private.");
}

function asManifest(value: unknown): T01ReplayManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid T01 replay manifest.");
  const manifest = value as Partial<T01ReplayManifest>;
  if (
    manifest.version !== T01_REPLAY_STATE_VERSION ||
    typeof manifest.ownerId !== "string" ||
    typeof manifest.expiresAt !== "number" ||
    !manifest.resources ||
    !manifest.records
  )
    throw new Error("Invalid T01 replay manifest.");
  return manifest as T01ReplayManifest;
}

function asSecrets(value: unknown): T01ReplaySecrets {
  if (!value || typeof value !== "object") throw new Error("Invalid T01 replay secrets.");
  const secrets = value as Partial<T01ReplaySecrets>;
  if (
    typeof secrets.databaseUrl !== "string" ||
    typeof secrets.supervisorToken !== "string" ||
    typeof secrets.encryptionKey !== "string" ||
    typeof secrets.testUserEmail !== "string" ||
    typeof secrets.testUserPassword !== "string"
  )
    throw new Error("Invalid T01 replay secrets.");
  return secrets as T01ReplaySecrets;
}

export async function createT01ReplayState(input: {
  directory: string;
  ownerId?: string;
  expiresAt: number;
  resources: T01ReplayManifest["resources"];
  records: T01ReplayManifest["records"];
  secrets: T01ReplaySecrets;
}): Promise<T01ReplayState> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(input.directory);
  const manifest: T01ReplayManifest = {
    version: T01_REPLAY_STATE_VERSION,
    ownerId: input.ownerId ?? randomUUID(),
    expiresAt: input.expiresAt,
    resources: input.resources,
    records: input.records,
  };
  await writeFile(privatePath(input.directory, manifestName), JSON.stringify(manifest), {
    mode: 0o600,
  });
  await writeFile(privatePath(input.directory, secretsName), JSON.stringify(input.secrets), {
    mode: 0o600,
  });
  return { directory: input.directory, manifest, secrets: input.secrets };
}

/** Persist non-secret ownership before Docker or OAuth can create a resource. */
export async function createT01ReplayIntent(input: {
  directory: string;
  ownerId: string;
  expiresAt: number;
  secrets: T01ReplaySecrets;
}): Promise<T01ReplayState> {
  return createT01ReplayState({ ...input, resources: {}, records: {} });
}

export async function updateT01ReplayIntent(
  state: T01ReplayState,
  update: Pick<T01ReplayManifest, "resources" | "records">,
): Promise<T01ReplayState> {
  const manifest = { ...state.manifest, resources: update.resources, records: update.records };
  await writeFile(privatePath(state.directory, manifestName), JSON.stringify(manifest), {
    mode: 0o600,
  });
  return { ...state, manifest };
}

export async function updateT01ReplaySecrets(
  state: T01ReplayState,
  secrets: T01ReplaySecrets,
): Promise<T01ReplayState> {
  await writeFile(privatePath(state.directory, secretsName), JSON.stringify(secrets), {
    mode: 0o600,
  });
  return { ...state, secrets };
}

export async function withT01ReplayLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  const filename = privatePath(directory, ".lock");
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(filename, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const held = JSON.parse(await readFile(filename, "utf8")) as { pid?: unknown };
        if (!Number.isInteger(held.pid) || typeof held.pid !== "number")
          throw new Error("T01 replay state is already in use.");
        try {
          process.kill(held.pid, 0);
          throw new Error("T01 replay state is already in use.");
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
          await unlink(filename);
        }
      } catch (recovery) {
        if ((recovery as Error).message === "T01 replay state is already in use.") throw recovery;
        throw new Error("T01 replay state is already in use.");
      }
    }
  }
  if (!handle) throw new Error("T01 replay state is already in use.");
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    return await operation();
  } finally {
    await handle.close();
    await unlink(filename).catch(() => undefined);
  }
}

export async function loadT01ReplayState(
  directory: string,
  now = Date.now(),
  options: { allowExpired?: boolean } = {},
): Promise<T01ReplayState> {
  const manifestPath = privatePath(directory, manifestName);
  const secretsPath = privatePath(directory, secretsName);
  await assertPrivateFile(manifestPath);
  await assertPrivateFile(secretsPath);
  const manifest = asManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (!options.allowExpired && manifest.expiresAt <= now)
    throw new Error("T01 replay state has expired; run teardown instead of replay.");
  return {
    directory,
    manifest,
    secrets: asSecrets(JSON.parse(await readFile(secretsPath, "utf8"))),
  };
}

export async function removeT01ReplayState(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function ownedT01ResourceLabels(ownerId: string): string[] {
  return [
    "rakazo.t01.scope=isolated",
    "rakazo.t01.runner=live-subscription",
    `rakazo.t01.owner=${ownerId}`,
  ];
}

export async function teardownT01ReplayState(input: {
  state: T01ReplayState;
  labelsForContainer: (name: string) => Promise<string[]>;
  labelsForNetwork: (name: string) => Promise<string[]>;
  removeContainer: (name: string) => Promise<void>;
  removeNetwork: (name: string) => Promise<void>;
  removeState?: (directory: string) => Promise<void>;
}): Promise<void> {
  const required = ownedT01ResourceLabels(input.state.manifest.ownerId);
  const owns = (labels: string[]) => required.every((label) => labels.includes(label));
  const containerName = input.state.manifest.resources.containerName;
  const networkName = input.state.manifest.resources.networkName;
  const databaseContainerName = input.state.manifest.resources.databaseContainerName;
  if (!containerName || !networkName || !databaseContainerName)
    throw new Error("T01 replay state is incomplete; use its owner-limited reap command.");
  if (!owns(await input.labelsForContainer(containerName)))
    throw new Error("Refusing to remove a container not owned by this T01 replay state.");
  if (!owns(await input.labelsForNetwork(networkName)))
    throw new Error("Refusing to remove a network not owned by this T01 replay state.");
  await input.removeContainer(containerName);
  if (!owns(await input.labelsForContainer(databaseContainerName)))
    throw new Error("Refusing to remove a database container not owned by this T01 replay state.");
  await input.removeContainer(databaseContainerName);
  await input.removeNetwork(networkName);
  await (input.removeState ?? removeT01ReplayState)(input.state.directory);
}

/** Crash recovery: enumerate only the owner UUID recorded in the private intent. */
export async function reapT01ReplayState(input: {
  state: T01ReplayState;
  listContainers: (ownerId: string) => Promise<string[]>;
  listNetworks: (ownerId: string) => Promise<string[]>;
  labelsForContainer: (name: string) => Promise<string[]>;
  labelsForNetwork: (name: string) => Promise<string[]>;
  removeContainer: (name: string) => Promise<void>;
  removeNetwork: (name: string) => Promise<void>;
  removeState?: (directory: string) => Promise<void>;
}): Promise<void> {
  const required = ownedT01ResourceLabels(input.state.manifest.ownerId);
  const owns = (labels: string[]) => required.every((label) => labels.includes(label));
  for (const name of await input.listContainers(input.state.manifest.ownerId)) {
    if (!owns(await input.labelsForContainer(name)))
      throw new Error("Refusing to reap a container not owned by this T01 replay state.");
    await input.removeContainer(name);
  }
  for (const name of await input.listNetworks(input.state.manifest.ownerId)) {
    if (!owns(await input.labelsForNetwork(name)))
      throw new Error("Refusing to reap a network not owned by this T01 replay state.");
    await input.removeNetwork(name);
  }
  await (input.removeState ?? removeT01ReplayState)(input.state.directory);
}
