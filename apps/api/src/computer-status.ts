import { createHash } from "node:crypto";
import { computerSupportsUpdate } from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, computerScreenSize } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Mirrors computer.takeover: an execution lease blocks user control unless a takeover is pending. */
export function executionBlocksUserTakeover(input: {
  hasLease: boolean;
  leaseExpiresAt: Date | null | undefined;
  runStatus: string | null | undefined;
  now?: number;
  takeoverRequested?: boolean;
}): boolean {
  if (!input.hasLease) return false;
  if (input.runStatus === "waiting_takeover" || input.takeoverRequested) return false;
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
    select: { status: true },
  });
  return executionBlocksUserTakeover({
    hasLease: true,
    leaseExpiresAt: lease.expiresAt,
    runStatus: run?.status,
    takeoverRequested: lease.computer.controlRunId === lease.runId,
  })
    ? input.botName
    : null;
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
  } | null,
  busyBotName: string | null = null,
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
  const screen = computerScreenSize(computer?.kind);
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  return {
    botId,
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? null,
    takeoverRequested: Boolean(computer?.controlRunId),
    screenAvailable: !computer?.maintenanceId && (state === "running" || state === "booting"),
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    screenStamp: screenStamp(botScreenGeneration, computer),
    busyBotName,
    canUpdate: computerSupportsUpdate(kind),
  };
}
