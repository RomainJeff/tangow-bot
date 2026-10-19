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
  // The orphan edge: an ensure that outlived its timeout returns a VM after its worker was
  // released, so start records it again for release and reconcile to destroy.
  released: ["releasing"],
};

/** The states a worker may move to `to` from: the `workerState IN (...)` guard of every CAS. */
export function workerStatesInto(to: WorkerState): WorkerState[] {
  return (Object.keys(WORKER_TRANSITIONS) as WorkerState[]).filter((from) =>
    WORKER_TRANSITIONS[from].includes(to),
  );
}

/**
 * What a setup step of `start` does when its move matched no row. `start` runs once per attempt,
 * so only teardown moved the worker. `record_ref`: releasing before any ref, so this call records
 * its VM for release to destroy now. `reopen_orphan`: released with no ref, so no row records the
 * VM. `stale`: the releasing actor knows the VM and owns teardown.
 */
export function lostSetupMove(
  observed: { workerState: WorkerState | null; workerProviderRef: string | null } | null,
): "record_ref" | "reopen_orphan" | "stale" {
  if (observed?.workerProviderRef !== null) return "stale";
  if (observed.workerState === "releasing") return "record_ref";
  if (observed.workerState === "released") return "reopen_orphan";
  return "stale";
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

/** How long `ensure` may take to create a VM. Release waits it out before trusting `absent`. */
export const WORKER_ENSURE_TIMEOUT_SECONDS = 15 * 60;

/**
 * A worker without a ref may still be under creation by its `ensure`, started at `workerEnsureAt`,
 * so a provider answering `absent` for its tag proves nothing until the ensure timeout has passed.
 */
export function ensureMayBeInFlight(
  worker: { workerProviderRef: string | null; workerEnsureAt: Date },
  now: Date,
): boolean {
  return (
    worker.workerProviderRef === null &&
    now.getTime() - worker.workerEnsureAt.getTime() < WORKER_ENSURE_TIMEOUT_SECONDS * 1000
  );
}

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

export type VolumeSlot = "private" | "shared";

export type LaunchPlan =
  | { mode: "in_process"; reason: "no_worker_provider" | "home_not_migrated" }
  | { mode: "refused"; refusal: { code: "slot_volume_missing"; slot: VolumeSlot } }
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
  const slots: Array<[VolumeSlot, VolumeAccess | null, string | null]> = [
    ["private", privateAccess, inputs.privateVolumeId],
    ["shared", sharedAccess, inputs.sharedVolumeId],
  ];
  const volumes: VolumeGrant[] = [];
  for (const [slot, access, volumeId] of slots) {
    if (!access) continue;
    if (!volumeId) return { mode: "refused", refusal: { code: "slot_volume_missing", slot } };
    volumes.push({ volumeId, access });
  }
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
