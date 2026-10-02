import { mkdir } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerUpdate } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, parseScreenLeaseId, screenLeaseId } from "@rakazo/core";
import {
  expireComputerExecutionLeases,
  type PrismaClient,
  parseComputerMode,
  type ThreadEvents,
} from "@rakazo/db";
import {
  clearInactiveUserComputerControl,
  expireComputerControl,
  hasActiveComputerControl,
} from "./computer-control.js";
import { toComputerRef } from "./computer-support.js";
import {
  checkpointComputerWorkspace,
  ensureComputerWorkspaceLayout,
  restoreComputerWorkspace,
} from "./computer-workspace.js";
import { resolveAgentHomePath } from "./home.js";
import { marketplacesRoot } from "./marketplace-store.js";
import { writeProvisioningDiagnostic } from "./provisioning-diagnostics.js";
import { userSkillsRoot } from "./skill-store.js";

type ComputerUpdateProgress = (
  stage: Exclude<ComputerUpdate["stage"], "preparing">,
) => Promise<void>;

const EXECUTION_LEASE_MS = 5 * 60_000;
const BOOT_WAIT_ATTEMPTS = 40;
const BOOT_WAIT_MS = 250;
/**
 * A booting claim newer than an execution-lease TTL is treated as live, not abandoned.
 * Dedicated / lease-less boots never write an execution-lease row, so this stamp age is the
 * lower bound before reclaim/Reset may treat a lease-less claim as abandoned. Align with
 * EXECUTION_LEASE_MS (a crashed team worker's lease would expire then). Slow dedicated boots
 * past this window stay protected while their run worker lease still heartbeats.
 */
const BOOT_CLAIM_STALE_MS = EXECUTION_LEASE_MS;

/**
 * Booting and suspending claims newer than an execution-lease TTL are live.
 * Older ones are abandoned: the worker died mid-transition, and Reset or a later
 * provision may reclaim them. Missing stamps fail closed (treated as live).
 */
function isAbandonedLifecycleClaim(updatedAt: Date | null | undefined, now = Date.now()): boolean {
  return updatedAt instanceof Date && now - updatedAt.getTime() >= BOOT_CLAIM_STALE_MS;
}

function isLiveSuspending(
  computer: { state: string; updatedAt?: Date | null },
  now = Date.now(),
): boolean {
  return computer.state === "suspending" && !isAbandonedLifecycleClaim(computer.updatedAt, now);
}

/**
 * "Nobody but us holds this computer."
 *
 * Whoever moves a computer to "booting" holds its execution lease for the whole provision,
 * renewed on the run heartbeat, so a booting row whose only live lease is our own belongs to
 * a worker that died between the claim and its own failure handler. Before this nothing
 * cleared that state -- the claim took only stopped/suspended/error rows and replaceComputer
 * refused a booting one -- so the computer stayed wedged for good and every run on its bot
 * retried forever.
 *
 * Used only when claiming an abandoned "booting" row. End-of-boot writes fence on the claim
 * stamp (updatedAt) instead: fencing them with this predicate too would let a second Team bot
 * lease that appears mid-provision block both activation and the failure write, leave the row
 * stuck in "booting", and destroy the valid winner's sandbox. A lease that merely expired
 * without being taken still passes, so a slow manual boot that never heartbeats keeps working.
 *
 * When screenLeaseId is absent, require that no live execution lease exists at all. Booting
 * reclaim compare-and-swaps the pre-wait updatedAt so two lease-less callers cannot both
 * match even if one re-reads the other's claim stamp during the boot wait.
 */
function heldByNobodyElse(lease: { ownerId: string; fence: number } | null) {
  return {
    executionLeases: {
      none: {
        expiresAt: { gt: new Date() },
        ...(lease ? { NOT: { runId: lease.ownerId, fence: lease.fence } } : {}),
      },
    },
  };
}

/**
 * A live execution lease held by some OTHER bot on this computer.
 *
 * replaceComputer already holds the lease for its own bot, so "any live lease" would always
 * be true there; a shared Team Computer mid-boot for a different bot must still be refused.
 */
async function hasForeignExecutionLease(
  prisma: PrismaClient,
  computerId: string,
  botId: string,
): Promise<boolean> {
  const live = await prisma.computerExecutionLease.findFirst({
    where: { computerId, botId: { not: botId }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return live !== null;
}

/**
 * A live worker lease on another run that uses this computer.
 *
 * Dedicated boots never take a computer execution lease, so after BOOT_CLAIM_STALE_MS the
 * claim stamp alone would look abandoned while provision is still running. A heartbeating
 * run lease proves the provisioner is alive. exceptRunId lets a recovering continueRun
 * reclaim its own abandoned boot without treating itself as foreign.
 */
async function hasLiveForeignRunLease(
  prisma: PrismaClient,
  computerId: string,
  exceptRunId?: string,
): Promise<boolean> {
  const live = await prisma.run.findFirst({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { computerId },
      leaseExpiresAt: { gt: new Date() },
      ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
    },
    select: { id: true },
  });
  return live !== null;
}

export class ComputerBusyError extends Error {
  constructor(readonly reason?: string) {
    super("Computer is busy");
    this.name = "ComputerBusyError";
  }
}

export { toComputerRef } from "./computer-support.js";

function computerUseRight(botId: string | undefined) {
  return botId
    ? {
        OR: [
          { bots: { some: { id: botId, archivedAt: null } } },
          { usageGrants: { some: { botId } } },
        ],
      }
    : {};
}

type ProvisionCasExpectation = {
  state: string;
  updatedAt?: Date | null;
  bootClaimStamp?: Date | null;
  providerRef: string | null;
  kind: string;
  maintenanceId: string | null;
};

async function diagnoseProvisionCasMismatch(
  prisma: PrismaClient,
  input: {
    step: "claim_cas.mismatch" | "activation_cas.mismatch" | "catch.mismatch";
    computerId: string;
    callerBotId?: string;
    expected: ProvisionCasExpectation;
    startedAt: number;
  },
): Promise<void> {
  if (process.env.RAKAZO_PROVISIONING_DIAGNOSTICS !== "1") return;
  const actual = await prisma.computer
    .findUnique({
      where: { id: input.computerId },
      select: {
        state: true,
        updatedAt: true,
        bootClaimStamp: true,
        providerRef: true,
        kind: true,
        maintenanceId: true,
        controlLeaseId: true,
        bots: { where: { archivedAt: null }, select: { id: true } },
        usageGrants: { select: { botId: true } },
      },
    })
    .catch(() => undefined);
  if (!actual) return;
  const hasUseRight =
    input.callerBotId === undefined ||
    actual.bots.some(({ id }) => id === input.callerBotId) ||
    actual.usageGrants.some(({ botId }) => botId === input.callerBotId);
  const mismatchedTerms = [
    ...(actual.state !== input.expected.state ? ["state"] : []),
    ...(input.expected.updatedAt !== undefined &&
    input.expected.updatedAt !== null &&
    actual.updatedAt.getTime() !== input.expected.updatedAt.getTime()
      ? ["updatedAt"]
      : []),
    ...(input.expected.bootClaimStamp !== undefined &&
    input.expected.bootClaimStamp !== null &&
    actual.bootClaimStamp?.getTime() !== input.expected.bootClaimStamp.getTime()
      ? ["bootClaimStamp"]
      : []),
    ...(actual.providerRef !== input.expected.providerRef ? ["providerRef"] : []),
    ...(actual.kind !== input.expected.kind ? ["kind"] : []),
    ...(actual.maintenanceId !== input.expected.maintenanceId ? ["maintenanceId"] : []),
    ...(!hasUseRight ? ["bots∪usageGrants"] : []),
  ];
  await writeProvisioningDiagnostic({
    step: input.step,
    computerId: input.computerId,
    callerBotId: input.callerBotId,
    ms: Date.now() - input.startedAt,
    expected: input.expected,
    actual: {
      state: actual.state,
      updatedAt: actual.updatedAt,
      bootClaimStamp: actual.bootClaimStamp,
      providerRef: actual.providerRef,
      kind: actual.kind,
      maintenanceId: actual.maintenanceId,
      controlLeaseId: Boolean(actual.controlLeaseId),
      ownerBots: actual.bots.map(({ id }) => id),
      usageGrants: actual.usageGrants.map(({ botId }) => botId),
    },
    mismatchedTerms,
  });
}

export async function provisionComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
  });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError("maintenance");
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const homePath = resolveAgentHomePath(deps.home, existing.homeKey, deps.dataDir ?? "./data");
  await mkdir(homePath, { recursive: true });
  // Docker would create missing bind sources as root; create them as the worker user first.
  if (deps.dataDir) {
    await mkdir(userSkillsRoot(deps.dataDir, context), { recursive: true });
    await mkdir(marketplacesRoot(deps.dataDir, context.spaceId), {
      recursive: true,
    });
  }

  // If we first observe abandoned "booting", remember that stamp before waiting. A concurrent
  // reclaim bumps updatedAt while state stays "booting"; fencing the claim on the pre-wait
  // stamp keeps those callers mutually exclusive. After the wait, a finished boot returns
  // "running" and takes the normal reconnect claim instead.
  //
  // Only reclaim stamps that were already older than an execution-lease TTL when we first
  // saw them. A fresher stamp means another caller may still be provisioning (dedicated and
  // lease-less boots can outlast the short boot-wait poll); stealing would double-provision
  // and roll back their sandbox. Live team boots with an execution lease are already blocked
  // by heldByNobodyElse; this guards the lease-less path (and expired-lease gaps).
  const reclaimStamp =
    existing.state === "booting" ? (existing.bootClaimStamp ?? existing.updatedAt) : null;
  const bootClaimIsStale =
    reclaimStamp !== null && Date.now() - reclaimStamp.getTime() >= BOOT_CLAIM_STALE_MS;
  // Idle stop does not refresh updatedAt while checkpointing or waiting on provider stop.
  // A live suspend can therefore age across the TTL during the ready wait; only reclaim
  // stamps that were already abandoned when we first saw them, matching booting reclaim.
  const suspendStamp = existing.state === "suspending" ? existing.updatedAt : null;
  const suspendClaimIsStale = suspendStamp !== null && isAbandonedLifecycleClaim(suspendStamp);
  // Never reclaim a fresh boot. A reconnect may join the existing provider reference;
  // a new Computer has no reference to join and fails fast instead of blocking the worker.
  if (existing.state === "booting" && reclaimStamp !== null && !bootClaimIsStale) {
    const reconnected = await joinComputerReconnect(deps, existing, context, Date.now());
    if (reconnected) return reconnected;
    throw new ComputerBusyError("boot_fresh_stamp");
  }
  // Do not consume the clock before the freshness decision above: lifecycle tests (and the
  // decision itself) use the first tick to establish whether a boot claim is still fresh.
  const diagnosticStartedAt = Date.now();
  const diagnose = (
    step: string,
    extra: Record<string, string | number | boolean | undefined> = {},
  ) =>
    writeProvisioningDiagnostic({
      step,
      computerId,
      botId: context.botId,
      ms: Date.now() - diagnosticStartedAt,
      ...extra,
    });
  if (
    existing.state === "booting" &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw new ComputerBusyError("boot_foreign_lease");
  }
  if (existing.state === "booting" || existing.state === "suspending") {
    existing = await waitForComputerReady(deps.prisma, computerId, context, diagnosticStartedAt);
  }
  // A booting row whose holder is gone is reclaimable. A suspending row is too once
  // its claim was already older than an execution-lease TTL when first observed and
  // no other run is still alive.
  const staleSuspending =
    existing.state === "suspending" &&
    suspendClaimIsStale &&
    !(await hasLiveForeignRunLease(deps.prisma, computerId, context.runId));
  if (
    !staleSuspending &&
    !["running", "stopped", "suspended", "error", "booting"].includes(existing.state)
  ) {
    throw new ComputerBusyError(`state_${existing.state}`);
  }
  // Waited for suspending (or similar) and landed on booting we never stamped: another
  // caller owns that boot. Do not adopt its updatedAt / previousRef and double-provision.
  if (existing.state === "booting" && reclaimStamp === null) {
    throw new ComputerBusyError("boot_unstamped");
  }
  // We came to reclaim abandoned booting; if another caller already activated, do not fall
  // through into reconnect (that would provision again under their providerRef).
  if (reclaimStamp !== null && existing.state === "running") {
    throw new ComputerBusyError("reclaim_lost");
  }
  // Stamp age is only a lower bound. Dedicated / lease-less boots can provision longer than
  // BOOT_CLAIM_STALE_MS; a heartbeating foreign run lease means the holder is still alive.
  if (
    existing.state === "booting" &&
    reclaimStamp !== null &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw new ComputerBusyError("boot_foreign_lease");
  }

  const reconnecting =
    Boolean(existing.providerRef) &&
    (existing.state === "running" || existing.state === "suspending");
  // Reconnect can allocate a replacement too. Claim it before any provider call,
  // and compare the observed reference so a delayed caller cannot replace a winner.
  // An abandoned "booting" row is claimed only when no other live execution lease remains,
  // and only when we observed "booting" (never as an OR arm on a running/stopped claim).
  const previousRef = {
    providerRef: existing.providerRef,
    kind: existing.kind,
  };
  const bootLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
  // Reclaim "booting" only when we observed it. Always ORing a booting arm lets a second
  // caller match after the first claimed running/stopped/… → booting and double-provision.
  // Stale "suspending" uses the same stamp fence so two recoveries cannot both provision.
  const claimWhere =
    existing.state === "booting" || existing.state === "suspending"
      ? {
          state: existing.state,
          ...(existing.state === "booting" && existing.bootClaimStamp
            ? { bootClaimStamp: reclaimStamp! }
            : { updatedAt: existing.state === "booting" ? reclaimStamp! : suspendStamp! }),
          ...(existing.state === "suspending" ? previousRef : {}),
          ...heldByNobodyElse(bootLease),
        }
      : {
          state: existing.state,
          ...previousRef,
        };
  // Choose the claim stamp before writing so a concurrent reclaim cannot make us adopt its
  // updatedAt on a follow-up read (which would let our activation overwrite the newer owner).
  // Advance past the observed stamp even when Date.now() equals it (same ms or clock skew);
  // otherwise a booting self-transition would leave the CAS token unchanged and a second
  // worker that observed the same stamp could also claim and provision.
  const observedStamp = reclaimStamp ?? suspendStamp ?? existing.updatedAt;
  const claimStamp = new Date(Math.max(Date.now(), observedStamp.getTime() + 1));
  await diagnose("claim_cas.before");
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      ...claimWhere,
      maintenanceId: existing.maintenanceId ?? null,
      // A Computer remains owned by its bots. A specialist may additionally be granted
      // use of its coordinator's mission Computer, without changing ownership.
      ...computerUseRight(context.botId),
    },
    data: { state: "booting", updatedAt: claimStamp, bootClaimStamp: claimStamp },
  });
  await diagnose("claim_cas.after", { count: claimed.count });
  if (claimed.count !== 1) {
    await diagnoseProvisionCasMismatch(deps.prisma, {
      step: "claim_cas.mismatch",
      computerId,
      callerBotId: context.botId,
      expected: {
        state: existing.state,
        updatedAt: existing.state === "booting" ? reclaimStamp : undefined,
        bootClaimStamp: existing.state === "booting" ? reclaimStamp : undefined,
        providerRef: previousRef.providerRef,
        kind: previousRef.kind,
        maintenanceId: existing.maintenanceId ?? null,
      },
      startedAt: diagnosticStartedAt,
    });
    if (existing.state === "running") {
      const reconnected = await joinComputerReconnect(deps, existing, context, diagnosticStartedAt);
      if (reconnected) return reconnected;
    }
    throw new ComputerBusyError("claim_failed");
  }
  let provisioned: ComputerRef | undefined;
  try {
    await onProgress?.("recreating");
    await diagnose("sandbox_provision.before");
    const ref = await deps.sandbox.provision(
      {
        botId: existing.homeKey,
        homePath,
        providerRef: existing.providerRef ?? undefined,
        providerKind: existing.kind as ComputerRef["kind"],
      },
      context,
    );
    await diagnose("sandbox_provision.after");
    provisioned = ref;
    await diagnose("sandbox_prepare.before");
    await deps.sandbox.prepare(ref, context);
    await diagnose("sandbox_prepare.after");
    const replacement =
      ref.fresh === true ||
      !existing.providerRef ||
      existing.providerRef !== ref.providerRef ||
      existing.kind !== ref.kind;
    if (replacement) {
      await onProgress?.("restoring");
      await diagnose("restore_workspace.before");
      await restoreComputerWorkspace(deps.home, deps.sandbox, existing.homeKey, ref, context);
      await diagnose("restore_workspace.after");
    }
    await onProgress?.("reconnecting");
    await diagnose("ensure_workspace_layout.before");
    await ensureComputerWorkspaceLayout(
      deps.sandbox,
      ref,
      parseComputerMode(existing.scope),
      context.botId,
      context,
    );
    await diagnose("ensure_workspace_layout.after");
    const activeControl = hasActiveComputerControl(existing);
    await diagnose("activation_cas.before");
    const activated = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "booting",
        bootClaimStamp: claimStamp,
        ...previousRef,
        maintenanceId: existing.maintenanceId ?? null,
        // Match the claim predicate above: activation is part of the same use right.
        // Otherwise a specialist can claim a mission Computer but can never move it
        // from booting to running.
        ...computerUseRight(context.botId),
      },
      data: {
        state: "running",
        bootClaimStamp: null,
        providerRef: ref.providerRef,
        kind: ref.kind,
        ...(!reconnecting
          ? {
              controlHolder: activeControl ? "user" : controlHolder,
              ...(!activeControl
                ? {
                    controlLeaseId: null,
                    controlLeaseExpiresAt: null,
                    controlBotId: null,
                    controlRunId: null,
                  }
                : {}),
            }
          : {}),
      },
    });
    await diagnose("activation_cas.after", { count: activated.count });
    if (activated.count !== 1) {
      await diagnoseProvisionCasMismatch(deps.prisma, {
        step: "activation_cas.mismatch",
        computerId,
        callerBotId: context.botId,
        expected: {
          state: "booting",
          updatedAt: claimStamp,
          bootClaimStamp: claimStamp,
          providerRef: previousRef.providerRef,
          kind: previousRef.kind,
          maintenanceId: existing.maintenanceId ?? null,
        },
        startedAt: diagnosticStartedAt,
      });
      const current = await deps.prisma.computer.findUniqueOrThrow({
        where: { id: computerId },
      });
      if (
        current.state === "running" &&
        current.providerRef === ref.providerRef &&
        current.kind === ref.kind
      ) {
        return ref;
      }
      throw new ComputerBusyError("activation_failed");
    }
    return ref;
  } catch (error) {
    await diagnose("catch", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    await diagnoseProvisionCasMismatch(deps.prisma, {
      step: "catch.mismatch",
      computerId,
      callerBotId: context.botId,
      expected: {
        state: "booting",
        updatedAt: claimStamp,
        bootClaimStamp: claimStamp,
        providerRef: previousRef.providerRef,
        kind: previousRef.kind,
        maintenanceId: existing.maintenanceId ?? null,
      },
      startedAt: diagnosticStartedAt,
    });
    if (error instanceof ComputerBusyError) {
      const current = await deps.prisma.computer.findUniqueOrThrow({
        where: { id: computerId },
      });
      if (
        provisioned &&
        current.state === "running" &&
        current.providerRef === provisioned.providerRef &&
        current.kind === provisioned.kind
      ) {
        return provisioned;
      }
    }
    // A failed reconnect never owns an existing workspace, even if setup failed.
    const rollbackError =
      provisioned && (!reconnecting || provisioned.fresh === true)
        ? await rollbackProvisionedComputer(deps.sandbox, provisioned, context, error)
        : undefined;
    try {
      await deps.prisma.computer.updateMany({
        where: {
          id: computerId,
          state: "booting",
          bootClaimStamp: claimStamp,
          ...previousRef,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: {
          state: reconnecting ? "running" : "error",
          bootClaimStamp: null,
          ...(!reconnecting && rollbackError && provisioned
            ? { providerRef: provisioned.providerRef, kind: provisioned.kind }
            : {}),
        },
      });
    } catch (recordError) {
      throw new AggregateError(
        [error, ...(rollbackError ? [rollbackError] : []), recordError],
        "Computer provisioning failed and its failure could not be recorded",
      );
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Computer provisioning failed and its sandbox could not be rolled back",
      );
    }
    throw error;
  }
}

/** Join only the same reconnect, without claiming or provisioning a second time. */
async function joinComputerReconnect(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  observed: { id: string; providerRef: string | null; kind: string; maintenanceId: string | null },
  context: AdapterContext,
  diagnosticStartedAt: number,
): Promise<ComputerRef | undefined> {
  if (!observed.providerRef) return;
  const current = await waitForComputerReady(
    deps.prisma,
    observed.id,
    context,
    diagnosticStartedAt,
  );
  if (current.state !== "running") return;
  // A lost CAS may mean revoked access or maintenance, not just a winning peer.
  // Recheck the same use right after waiting, against the current running reference.
  const authorized = await deps.prisma.computer.findFirst({
    where: {
      id: observed.id,
      state: "running",
      providerRef: observed.providerRef,
      kind: observed.kind,
      maintenanceId: observed.maintenanceId ?? null,
      ...computerUseRight(context.botId),
    },
  });
  if (!authorized) return;
  const ref = { ...toComputerRef(authorized), fresh: false };
  await ensureComputerWorkspaceLayout(
    deps.sandbox,
    ref,
    parseComputerMode(authorized.scope),
    context.botId,
    context,
  );
  return ref;
}

async function waitForComputerReady(
  prisma: PrismaClient,
  computerId: string,
  context: AdapterContext,
  diagnosticStartedAt: number,
) {
  const diagnose = (
    step: string,
    extra: Record<string, string | number | boolean | undefined> = {},
  ) =>
    writeProvisioningDiagnostic({
      step,
      computerId,
      botId: context.botId,
      ms: Date.now() - diagnosticStartedAt,
      ...extra,
    });
  await diagnose("wait_ready.before");
  for (let attempt = 0; attempt < BOOT_WAIT_ATTEMPTS; attempt += 1) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("computer boot aborted");
    }
    const current = await prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    await diagnose("wait_ready.poll", {
      attempt,
      state: current.state,
      updatedAgeMs: Date.now() - current.updatedAt.getTime(),
    });
    if (current.state === "running" && current.providerRef) {
      await diagnose("wait_ready.after", { state: current.state });
      return current;
    }
    if (current.state !== "booting" && current.state !== "suspending") {
      await diagnose("wait_ready.after", { state: current.state });
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_MS));
  }
  const current = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  await diagnose("wait_ready.after", { state: current.state });
  return current;
}

async function rollbackProvisionedComputer(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  cause: unknown,
): Promise<unknown | undefined> {
  try {
    await sandbox.releaseScreen?.(computer, context).catch(() => undefined);
    if (computer.fresh) {
      await sandbox.destroy(computer, context);
    } else if (cause instanceof ComputerBusyError) {
      try {
        await sandbox.stop(computer, context);
      } catch {
        await sandbox.destroy(computer, context);
      }
    } else {
      await sandbox.stop(computer, context);
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

export interface ComputerExecutionLease {
  computerId: string;
  botId: string;
  runId: string;
  fence: number;
}

export function screenLeaseIdForRun(
  lease: Pick<ComputerExecutionLease, "runId" | "fence"> | null,
  runId: string,
  fence = 0,
): string {
  return screenLeaseId(lease?.runId ?? runId, lease?.fence ?? fence);
}

export async function acquireComputerExecutionLease(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
    resumeHeldLease?: boolean;
  },
): Promise<ComputerExecutionLease | null> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: input.computerId },
  });
  if (computer.maintenanceId && computer.maintenanceId !== input.runId)
    throw new ComputerBusyError("maintenance");
  if (computer.scope !== "team") return null;
  if (isLiveSuspending(computer)) throw new ComputerBusyError("suspending");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
  const [reclaimed] = await prisma.computerExecutionLease.updateManyAndReturn({
    where: {
      computerId: input.computerId,
      botId: input.botId,
      OR: [{ expiresAt: { lt: now } }, ...(input.resumeHeldLease ? [{ runId: input.runId }] : [])],
    },
    data: {
      runId: input.runId,
      expiresAt,
      fence: { increment: 1 },
    },
    select: { fence: true },
  });
  if (reclaimed) {
    return validateAcquiredComputerLease(prisma, {
      computerId: input.computerId,
      botId: input.botId,
      runId: input.runId,
      fence: reclaimed.fence,
    });
  }
  try {
    const created = await prisma.computerExecutionLease.create({
      data: {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: 1,
        expiresAt,
      },
      select: { fence: true },
    });
    return validateAcquiredComputerLease(prisma, {
      computerId: input.computerId,
      botId: input.botId,
      runId: input.runId,
      fence: created.fence,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new ComputerBusyError("claim_failed");
    throw error;
  }
}

async function validateAcquiredComputerLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease,
): Promise<ComputerExecutionLease> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: lease.computerId },
    select: { state: true, maintenanceId: true, updatedAt: true },
  });
  if (
    !isLiveSuspending(computer) &&
    (!computer.maintenanceId || computer.maintenanceId === lease.runId)
  )
    return lease;
  await releaseComputerExecutionLease(prisma, lease);
  throw new ComputerBusyError("lease_validate");
}

export async function renewComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const renewed = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS) },
  });
  return renewed.count === 1;
}

export async function holdComputerExecutionLeaseForTakeover(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const held = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) },
  });
  return held.count === 1;
}

export async function releaseComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<void> {
  if (!lease) return;
  // Keep the row as an expired tombstone so the next run for this bot increments
  // its fence. Deleting it resets the fence to 1, which lets a still-open screen
  // session from the previous run reject the new run as stale.
  await expireComputerExecutionLeases(prisma, {
    computerId: lease.computerId,
    botId: lease.botId,
    runId: lease.runId,
    fence: lease.fence,
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export type ComputerReplaceMode = "recover" | "reset" | "update";

export function computerSupportsUpdate(kind: string): boolean {
  return kind !== "desktop";
}

export async function replaceComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  mode: ComputerReplaceMode,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
  });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError("maintenance");
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    const expired = await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    // Failed provider revoke keeps the lease for retry; do not wipe it and continue reset.
    if (!expired && existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  // Orphaned controlHolder=user with no lease id can be cleared for reset/recover.
  if (
    existing.controlHolder === "user" &&
    !hasActiveComputerControl(existing) &&
    !existing.controlLeaseId
  ) {
    await clearInactiveUserComputerControl(deps.prisma, existing.id);
    existing = await deps.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    if (existing.controlHolder === "user" && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const botId = context.botId;
  if (!botId) throw new Error("computer replacement requires a bot id");
  if (hasActiveComputerControl(existing)) {
    throw new ComputerBusyError("control_active");
  }
  const bootClaimStamp =
    existing.state === "booting" ? (existing.bootClaimStamp ?? existing.updatedAt) : null;
  // Reset is the in-product recovery for a hung suspend. Recover and update still refuse
  // so they cannot destroy a computer that is only stuck, not requested as a Reset.
  if (existing.state === "suspending" && mode !== "reset") {
    throw new ComputerBusyError("suspending");
  }
  // Allow Reset on a stale "booting" or "suspending" row unless another bot still holds a live
  // lease. Dedicated computers never create an execution-lease row, so the foreign-lease check
  // alone cannot see an in-flight dedicated boot or idle stop. Refuse claim stamps younger than
  // an execution-lease TTL (not merely the boot-wait poll) so a slow dedicated provision or
  // suspend is not destroyed mid-flight. Also refuse while a run still uses the computer —
  // before claiming suspending — so rollback cannot bump @updatedAt under an in-flight boot.
  if (existing.state === "booting" || existing.state === "suspending") {
    if (await hasForeignExecutionLease(deps.prisma, computerId, botId)) {
      throw new ComputerBusyError("boot_foreign_lease");
    }
    if (!isAbandonedLifecycleClaim(bootClaimStamp ?? existing.updatedAt)) {
      throw new ComputerBusyError(existing.state === "booting" ? "boot_fresh_stamp" : "suspending");
    }
    const activeBootRun = await deps.prisma.run.findFirst({
      where: {
        status: { in: [...ACTIVE_RUN_STATUSES] },
        bot: { computerId },
      },
      select: { id: true },
    });
    if (activeBootRun) throw new ComputerBusyError("boot_active_run");
  }

  const previousState = existing.state;
  const now = new Date();
  const claimStamp = new Date(Math.max(now.getTime(), existing.updatedAt.getTime() + 1));
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: previousState,
      maintenanceId: existing.maintenanceId ?? null,
      // CAS the dedicated boot claim stamp so unrelated metadata writes cannot make a
      // legitimate stale-boot Reset lose its claim.
      ...(previousState === "booting"
        ? existing.bootClaimStamp
          ? { bootClaimStamp: existing.bootClaimStamp }
          : { updatedAt: existing.updatedAt }
        : previousState === "suspending"
          ? { updatedAt: existing.updatedAt }
          : {}),
      executionLeases: {
        none: { botId: { not: botId }, expiresAt: { gt: now } },
      },
      OR: [
        { controlHolder: { not: "user" } },
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      state: "suspending",
      updatedAt: claimStamp,
      ...(previousState === "booting" ? { bootClaimStamp: null } : {}),
    },
  });
  if (claimed.count !== 1) throw new ComputerBusyError("claim_failed");
  // Re-check after the claim in case a run started between the pre-check and CAS.
  const activeRun = await deps.prisma.run.findFirst({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { computerId },
    },
    select: { id: true },
  });
  if (activeRun) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "suspending", updatedAt: claimStamp },
      data: {
        state: previousState,
        ...(previousState === "booting" ? { bootClaimStamp } : {}),
      },
    });
    throw new ComputerBusyError("active_run");
  }

  const oldRef = existing.providerRef ? toComputerRef(existing) : null;
  try {
    // Retry the checkpoint even after an earlier update left the row in error.
    if (oldRef && (mode === "update" || (existing.state === "running" && mode === "recover"))) {
      try {
        await onProgress?.("saving");
        const revision = await checkpointComputerWorkspace(
          deps.home,
          deps.sandbox,
          existing.homeKey,
          oldRef,
          context,
        );
        const recorded = await deps.prisma.computer.updateMany({
          where: { id: computerId, state: "suspending", updatedAt: claimStamp },
          data: { homeRevision: revision, updatedAt: claimStamp },
        });
        if (recorded.count !== 1) throw new ComputerBusyError();
      } catch (error) {
        if (mode !== "recover" || error instanceof ComputerBusyError) throw error;
      }
    }
    await onProgress?.("recreating");
    if (oldRef) {
      await deps.sandbox.releaseScreen?.(oldRef, context).catch(() => undefined);
      try {
        await deps.sandbox.destroy(oldRef, context);
      } catch (error) {
        if (mode !== "recover") throw error;
      }
    }
    const stopped = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "suspending",
        updatedAt: claimStamp,
        maintenanceId: existing.maintenanceId ?? null,
      },
      data: {
        state: "stopped",
        providerRef: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
        updatedAt: claimStamp,
      },
    });
    if (stopped.count !== 1) throw new ComputerBusyError("state_transition_failed");
    return provisionComputer(deps, computerId, context, controlHolder, onProgress);
  } catch (error) {
    await deps.prisma.computer
      .updateMany({
        where: {
          id: computerId,
          updatedAt: claimStamp,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: { state: "error" },
      })
      .catch(() => undefined);
    throw error;
  }
}
