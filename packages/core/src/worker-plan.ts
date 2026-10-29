import type {
  ComputerMode,
  HomeStorage,
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

/**
 * Upper bound of a worker VM's life at the provider. It frees a volume held by a worker whose
 * destruction was never confirmed: past it the provider reports the VM absent. One hour is the
 * longest sandbox timeout E2B's base plan and a default self-hosted deployment accept.
 */
export const WORKER_TTL_SECONDS = 60 * 60;

/** How long `ensure` may take to create a VM. Release waits it out before trusting `absent`. */
export const WORKER_ENSURE_TIMEOUT_SECONDS = 15 * 60;

/** When an `ensure` started at `workerEnsureAt` must have stopped creating its VM. */
export function workerEnsureDeadline(workerEnsureAt: Date): Date {
  return new Date(workerEnsureAt.getTime() + WORKER_ENSURE_TIMEOUT_SECONDS * 1000);
}

/**
 * A worker without a ref may still be under creation by its `ensure`, started at `workerEnsureAt`,
 * so a provider answering `absent` for its tag proves nothing until the ensure deadline has passed.
 */
export function ensureMayBeInFlight(
  worker: { workerProviderRef: string | null; workerEnsureAt: Date },
  now: Date,
): boolean {
  return (
    worker.workerProviderRef === null &&
    now.getTime() < workerEnsureDeadline(worker.workerEnsureAt).getTime()
  );
}

/** What a run asks for, by slot: the run's own bot and space fill them, never a caller's id. */
export type RunNeeds = {
  files: { private: VolumeAccess | null; shared: VolumeAccess | null };
  computer: "none" | "on_use";
};

/**
 * What a run asks of a worker. Any tool the guest runs works on the bot's home, so it needs the
 * private slot and the space's shared slot, which also holds shared skills. A team home move
 * fences starts across the space while it copies shared files.
 * Whether the home is on volumes at all is `planLaunch`'s call.
 */
export function deriveRunNeeds(run: {
  guestTools: boolean;
  computerTools: boolean;
  computerScope: ComputerMode | null;
}): RunNeeds {
  const files = run.guestTools ? "rw" : null;
  return {
    files: { private: files, shared: files },
    computer: run.computerTools && run.computerScope ? "on_use" : "none",
  };
}

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
  | {
      mode: "refused";
      refusal: { code: "slot_volume_missing"; slot: VolumeSlot } | { code: "home_move_pending" };
    }
  | { mode: "busy"; reason: "home_moving" }
  | WorkerLaunch;

export type LaunchInputs = {
  homeMoving?: boolean;
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
  if (inputs.homeMoving) return { mode: "busy", reason: "home_moving" };
  const { private: privateAccess, shared: sharedAccess } = needs.files;
  if ((privateAccess || sharedAccess) && inputs.computer?.homeStorage !== "volumes") {
    return { mode: "refused", refusal: { code: "home_move_pending" } };
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

/** A run paused on the user stays its attempt's: the attempt may conclude its turn, not act. */
export function attemptOwnsFence(
  attempt: { fence: number },
  run: { leaseFence: number; status: string },
): boolean {
  return (
    attemptHoldsFence(attempt, run) ||
    (attempt.fence === run.leaseFence &&
      (run.status === "queued" ||
        run.status === "waiting_input" ||
        run.status === "waiting_takeover"))
  );
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

/** Whether a path is at or under the places volumes mount: `/workspace/shared` and `/workspace/bots`. */
export function underVolumeMounts(absolute: string): boolean {
  return [volumeMountPath({ kind: "space_shared" }), `${WORKSPACE_ROOT}/bots`].some(
    (root) => absolute === root || absolute.startsWith(`${root}/`),
  );
}

/** How a computer whose home is on volumes mounts them, and where its workspace starts. */
export type VolumeHome = { root: string; mounts: Array<{ volumeRef: string; path: string }> };

/**
 * A computer mounts its home's volumes at the paths every worker uses, so a file has one absolute
 * path in every VM. A team computer's workspace is the team root; a dedicated one's is its bot's
 * home, the same place a guest's relative paths land.
 */
export function computerVolumeHome(
  scope: ComputerMode,
  volumes: ReadonlyArray<Pick<VolumeRow, "kind" | "botId" | "providerRef">>,
): VolumeHome {
  const mounts = volumes.flatMap((volume) =>
    volume.providerRef
      ? [
          {
            volumeRef: volume.providerRef,
            path: volumeMountPath(
              volume.kind === "bot_private"
                ? { kind: volume.kind, botId: volume.botId ?? "" }
                : { kind: volume.kind },
            ),
          },
        ]
      : [],
  );
  const home = mounts.find((mount) => mount.path !== volumeMountPath({ kind: "space_shared" }));
  return { root: scope === "team" ? WORKSPACE_ROOT : (home?.path ?? WORKSPACE_ROOT), mounts };
}

export type VolumeRow = {
  id: string;
  kind: VolumeKind;
  spaceId: string;
  botId: string | null;
  providerKind: string;
  providerRef: string | null;
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
