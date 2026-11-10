import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import { hasActiveComputerControl } from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";
import { SandboxKind } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const releases = new WeakMap<
  SandboxProvider,
  { expiresAt: number; value: Promise<string | null> }
>();

/** A provider outage must not prevent opening a conversation or a computer. */
export function currentComputerRelease(
  sandbox: SandboxProvider | undefined,
  actor: Pick<AdapterContext, "spaceId" | "userId">,
): Promise<string | null> {
  if (!sandbox?.currentRelease) return Promise.resolve(null);
  const cached = releases.get(sandbox);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = sandbox
    .currentRelease({
      ...actor,
      operationId: "computer-release",
      traceId: randomUUID(),
      signal: AbortSignal.timeout(3_000),
    })
    .catch(() => null);
  releases.set(sandbox, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

/** Mirrors computer.takeover: an execution lease blocks user control unless a takeover is pending. */
export function executionBlocksUserTakeover(input: {
  hasLease: boolean;
  leaseExpiresAt: Date | null | undefined;
  runStatus: string | null | undefined;
  now?: number;
  takeoverRequested?: boolean;
  /** Another person's run on a shared bot: the takeover it waits for is theirs alone. */
  othersRun?: boolean;
}): boolean {
  if (!input.hasLease) return false;
  if (!input.othersRun && (input.runStatus === "waiting_takeover" || input.takeoverRequested)) {
    return false;
  }
  const now = input.now ?? Date.now();
  const leaseActive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > now);
  const runActive = Boolean(
    input.runStatus && (ACTIVE_RUN_STATUSES as readonly string[]).includes(input.runStatus),
  );
  return leaseActive || runActive;
}

export async function resolveBusyBotName(
  prisma: PrismaClient,
  input: {
    computerId: string | null | undefined;
    botId: string;
    botName: string;
    /** The person looking: another person's run on a shared bot keeps the computer busy for them. */
    userId: string;
  },
): Promise<string | null> {
  if (!input.computerId) return null;
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { expiresAt: true, runId: true, computer: { select: { controlRunId: true } } },
  });
  if (!lease) return null;
  const run = await prisma.run.findUnique({
    where: { id: lease.runId },
    select: { status: true, userId: true },
  });
  return executionBlocksUserTakeover({
    hasLease: true,
    leaseExpiresAt: lease.expiresAt,
    runStatus: run?.status,
    takeoverRequested: lease.computer.controlRunId === lease.runId,
    othersRun: Boolean(run && run.userId !== input.userId),
  })
    ? input.botName
    : null;
}

type ControlledComputer = Parameters<typeof hasActiveComputerControl>[0] & {
  controlBotId?: string | null;
  controlRunId?: string | null;
};

/**
 * Whether `userId` holds the bot's computer. Control taken for a run belongs to that run's person,
 * which on a shared bot may be a member; control taken by hand is only ever the owner's.
 */
export async function holdsComputerControl(
  prisma: PrismaClient,
  computer: ControlledComputer | null | undefined,
  bot: { id: string; userId: string },
  userId: string,
): Promise<boolean> {
  if (!computer || !hasActiveComputerControl(computer) || computer.controlBotId !== bot.id) {
    return false;
  }
  const run = computer.controlRunId
    ? await prisma.run.findUnique({
        where: { id: computer.controlRunId },
        select: { userId: true },
      })
    : null;
  return run ? run.userId === userId : bot.userId === userId;
}

/** The bot's computer as `userId` sees it: control another person holds on it is not theirs. */
export async function computerSeenBy<T extends ControlledComputer>(
  prisma: PrismaClient,
  bot: { id: string; userId: string; computer: T | null },
  userId: string,
): Promise<T | null> {
  const computer = bot.computer;
  if (!computer || computer.controlBotId !== bot.id || !hasActiveComputerControl(computer)) {
    return computer;
  }
  if (await holdsComputerControl(prisma, computer, bot, userId)) return computer;
  return { ...computer, controlHolder: "none", controlBotId: null, controlRunId: null };
}

/** Changes exactly when the capability sealed by `computer.screenUrl` stops matching the proxy's checks. */
function screenStamp(
  botScreenGeneration: number,
  computer: { id: string; screenGeneration: number; controlLeaseId?: string | null } | null,
): string {
  if (!computer) return "";
  return createHash("sha256")
    .update(
      `${computer.id}:${computer.screenGeneration}:${botScreenGeneration}:${computer.controlLeaseId ?? ""}`,
    )
    .digest("hex")
    .slice(0, 16);
}

export function toComputerStatus(
  botId: string,
  botScreenGeneration: number,
  computer: {
    id: string;
    screenGeneration: number;
    controlLeaseId?: string | null;
    kind: string;
    state: string;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    controlRunId?: string | null;
    homeRevision: string;
    maintenanceId?: string | null;
    providerRef?: string | null;
    releaseRef?: string | null;
  } | null,
  busyBotName: string | null = null,
  currentRelease: string | null = null,
): ComputerStatus {
  const state = computer?.maintenanceId
    ? "booting"
    : computer?.state === "suspending"
      ? "running"
      : computer?.state === "stopped" ||
          computer?.state === "booting" ||
          computer?.state === "running" ||
          computer?.state === "suspended" ||
          computer?.state === "error"
        ? computer.state
        : "stopped";
  // A row left by a removed provider (daytona, box) reads as fake until its next boot replaces it.
  const kind = SandboxKind.catch("fake").parse(computer?.kind);
  return {
    botId,
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? null,
    takeoverRequested: Boolean(computer?.controlRunId),
    screenAvailable: !computer?.maintenanceId && (state === "running" || state === "booting"),
    screenWidth: DEFAULT_COMPUTER_SCREEN.width,
    screenHeight: DEFAULT_COMPUTER_SCREEN.height,
    homeRevision: computer?.homeRevision ?? null,
    screenStamp: screenStamp(botScreenGeneration, computer),
    busyBotName,
    canUpdate: true,
    updateAvailable: Boolean(
      computer?.providerRef && currentRelease && computer.releaseRef !== currentRelease,
    ),
  };
}
