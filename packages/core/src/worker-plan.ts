import type {
  HomeStorage,
  SandboxKind,
  VolumeAccess,
  VolumeKind,
  WorkerState,
} from "@rakazo/contracts";

export const LIVE_WORKER_STATES = [
  "requested",
  "created",
  "ready",
] as const satisfies readonly WorkerState[];

const WORKER_TRANSITIONS: Record<WorkerState, readonly WorkerState[]> = {
  requested: ["created", "releasing"],
  created: ["ready", "releasing"],
  ready: ["releasing"],
  releasing: ["released"],
  released: [],
};

/** The states a worker may move to `to` from: the `workerState IN (...)` guard of every CAS. */
export function workerStatesInto(to: WorkerState): WorkerState[] {
  return (Object.keys(WORKER_TRANSITIONS) as WorkerState[]).filter((from) =>
    WORKER_TRANSITIONS[from].includes(to),
  );
}

/** Which computer kinds can move a home onto worker volumes. A new SandboxKind must declare one. */
export const WORKER_SUPPORT = {
  e2b: "worker",
  docker: "in_process",
  daytona: "in_process",
  box: "in_process",
  desktop: "in_process",
  fake: "in_process",
} as const satisfies Record<SandboxKind, "worker" | "in_process">;

export function supportsWorkers(computerKind: string): boolean {
  return (WORKER_SUPPORT as Record<string, string>)[computerKind] === "worker";
}

/**
 * Upper bound of a worker VM's life at the provider. It frees a volume held by a worker whose
 * destruction was never confirmed: past it the provider reports the VM absent.
 */
export const WORKER_TTL_SECONDS = 4 * 60 * 60;

/** What a run asks for, by slot: the run's own bot and space fill them, never a caller's id. */
export type RunNeeds = {
  files: { private: VolumeAccess | null; shared: VolumeAccess | null };
  computer: "none" | "on_use";
};

export type VolumeGrant = { volumeId: string; access: VolumeAccess };

export type WorkerLaunch = {
  mode: "worker";
  runId: string;
  botId: string;
  spaceId: string;
  attemptId: string;
  fence: number;
  volumes: VolumeGrant[];
  computer: { mode: "none" } | { mode: "on_use"; computerId: string };
};

export type LaunchPlan =
  | { mode: "in_process"; reason: "no_worker_provider" | "home_not_migrated" }
  | WorkerLaunch;

export type LaunchInputs = {
  runId: string;
  botId: string;
  spaceId: string;
  attemptId: string;
  fence: number;
  computer: { id: string; homeStorage: HomeStorage } | null;
  privateVolumeId: string | null;
  sharedVolumeId: string | null;
};

export function planLaunch(inputs: LaunchInputs, needs: RunNeeds): LaunchPlan {
  const { private: privateAccess, shared: sharedAccess } = needs.files;
  if ((privateAccess || sharedAccess) && inputs.computer?.homeStorage !== "volumes") {
    return { mode: "in_process", reason: "home_not_migrated" };
  }
  const volumes: VolumeGrant[] = [];
  if (privateAccess)
    volumes.push({ volumeId: ownVolume(inputs.privateVolumeId), access: privateAccess });
  if (sharedAccess)
    volumes.push({ volumeId: ownVolume(inputs.sharedVolumeId), access: sharedAccess });
  return {
    mode: "worker",
    runId: inputs.runId,
    botId: inputs.botId,
    spaceId: inputs.spaceId,
    attemptId: inputs.attemptId,
    fence: inputs.fence,
    volumes,
    computer:
      needs.computer === "on_use" && inputs.computer
        ? { mode: "on_use", computerId: inputs.computer.id }
        : { mode: "none" },
  };
}

function ownVolume(volumeId: string | null): string {
  // adoptVolumeHome refuses a home whose volumes are not all provisioned.
  if (!volumeId) throw new Error("A migrated home is missing its volume");
  return volumeId;
}

/** Only the attempt that claimed the run's current fence, while the run is claimed, may act. */
export function attemptHoldsFence(
  attempt: { fence: number },
  run: { leaseFence: number; status: string },
): boolean {
  return attempt.fence === run.leaseFence && (run.status === "leased" || run.status === "running");
}

export const WORKSPACE_ROOT = "/workspace";
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The guest path of a volume, the same in every VM that mounts it. */
export function volumeMountPath(
  owner: { kind: "bot_private"; botId: string } | { kind: "space_shared" },
): string {
  if (owner.kind === "space_shared") return `${WORKSPACE_ROOT}/shared`;
  if (!PATH_SEGMENT.test(owner.botId)) throw new Error("Invalid bot id for a mount path");
  return `${WORKSPACE_ROOT}/bots/${owner.botId}`;
}

export type VolumeRow = {
  id: string;
  kind: VolumeKind;
  spaceId: string;
  botId: string | null;
  providerKind: string;
  providerRef: string | null;
  writerAttemptId: string | null;
};

export type AuthorizedMount = {
  volumeId: string;
  volumeRef: string;
  path: string;
  scope: "private" | "shared";
  access: VolumeAccess;
};

export type MountRefusalCode =
  | "volume_not_found"
  | "private_volume_of_other_bot"
  | "shared_volume_of_other_space"
  | "volume_not_provisioned"
  | "provider_mismatch"
  | "read_only_unsupported";

export type MountRefusal = { code: MountRefusalCode; volumeId: string };

/** Checks every grant against the run's bot and space. The path comes from the row, never the grant. */
export function authorizeMounts(
  scope: { botId: string; spaceId: string },
  grants: readonly VolumeGrant[],
  rows: readonly VolumeRow[],
  provider: { kind: string; readOnlyMounts: boolean },
): { ok: true; mounts: AuthorizedMount[] } | { ok: false; refusal: MountRefusal } {
  const mounts: AuthorizedMount[] = [];
  for (const grant of grants) {
    const refuse = (code: MountRefusalCode) =>
      ({ ok: false, refusal: { code, volumeId: grant.volumeId } }) as const;
    const row = rows.find((candidate) => candidate.id === grant.volumeId);
    if (!row) return refuse("volume_not_found");
    if (row.kind === "bot_private" && row.botId !== scope.botId) {
      return refuse("private_volume_of_other_bot");
    }
    if (row.kind === "space_shared" && row.spaceId !== scope.spaceId) {
      return refuse("shared_volume_of_other_space");
    }
    if (!row.providerRef) return refuse("volume_not_provisioned");
    if (row.providerKind !== provider.kind) return refuse("provider_mismatch");
    if (grant.access === "ro" && !provider.readOnlyMounts) return refuse("read_only_unsupported");
    mounts.push({
      volumeId: row.id,
      volumeRef: row.providerRef,
      path: volumeMountPath(
        row.kind === "bot_private" ? { kind: row.kind, botId: scope.botId } : { kind: row.kind },
      ),
      scope: row.kind === "bot_private" ? "private" : "shared",
      access: grant.access,
    });
  }
  return { ok: true, mounts };
}

/**
 * The writable volumes another attempt still writes. A lease frees only when its holder's VM is
 * confirmed gone, never on a clock.
 */
export function writersBlocking(
  attemptId: string,
  mounts: readonly AuthorizedMount[],
  rows: readonly VolumeRow[],
): string[] {
  return mounts
    .filter((mount) => mount.access === "rw")
    .filter((mount) => {
      const writer = rows.find((row) => row.id === mount.volumeId)?.writerAttemptId;
      return writer != null && writer !== attemptId;
    })
    .map((mount) => mount.volumeId);
}

export type HomePersistence = "snapshot" | "mounted" | "volumes";

/**
 * How a computer home persists. `snapshot` imports on a fresh machine and exports at checkpoints;
 * `mounted` is the Docker computer whose disk is the local store; `volumes` never copies, the live
 * volumes are the durable home.
 */
export function homePersistence(home: {
  homeStorage: HomeStorage;
  computerKind: string;
  homeStore: { describe(): { id: string } };
}): HomePersistence {
  if (home.homeStorage === "volumes") return "volumes";
  if (home.computerKind === "docker" && home.homeStore.describe().id === "local-fs") {
    return "mounted";
  }
  return "snapshot";
}
