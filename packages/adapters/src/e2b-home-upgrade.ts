import { randomUUID } from "node:crypto";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

/** Operator-only preparation while application services are stopped; copying remains the home mover's job. */
export async function prepareHomeForE2B(
  deps: { prisma: PrismaClient; home: AgentHomeStore; source: SandboxProvider },
  computerId: string,
  context: AdapterContext,
): Promise<void> {
  const { prisma, home, source } = deps;
  const scope = await prisma.computer.findUniqueOrThrow({
    where: { id: computerId },
    select: { spaceId: true },
  });
  const stale = await prisma.computer.findMany({
    where: {
      spaceId: scope.spaceId,
      maintenanceId: { startsWith: "home-move:" },
      homeMoveExpiresAt: { lte: new Date() },
    },
    select: { id: true },
  });
  const lifecycle = createWorkerLifecycle({ prisma, provider: null });
  for (const computer of stale) await lifecycle.clearStaleHomeMove(computer.id);
  const marker = `home-move:${computerId}:${randomUUID()}`;
  const original = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`;
    const computer = await tx.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (computer.homeStorage === "volumes") return null;
    if (computer.kind !== "docker" && computer.kind !== "e2b")
      throw new Error("Unsupported source computer provider");
    const now = new Date();
    const active = await tx.run.count({
      where: { spaceId: computer.spaceId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    const controlled = await tx.computer.count({
      where: {
        spaceId: computer.spaceId,
        OR: [
          { controlHolder: { not: "none" } },
          { maintenanceId: { not: null } },
          { executionLeases: { some: { expiresAt: { gt: now } } } },
        ],
      },
    });
    if (active || controlled)
      throw new Error("Computer upgrade refused: active run, control, lease or maintenance");
    await tx.computer.update({
      where: { id: computerId },
      data: {
        maintenanceId: marker,
        homeMoveExpiresAt: new Date(Date.now() + 60000),
      },
    });
    return computer;
  });
  if (!original) return;
  const abort = new AbortController();
  const ctx = { ...context, signal: AbortSignal.any([context.signal, abort.signal]) };
  let renewing = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewing = renewing
      .then(async () => {
        const renewed = await prisma.computer.updateMany({
          where: {
            id: computerId,
            maintenanceId: marker,
            homeMoveExpiresAt: { gt: new Date() },
          },
          data: { homeMoveExpiresAt: new Date(Date.now() + 60000) },
        });
        if (renewed.count !== 1) throw new Error("Home preparation ownership expired");
      })
      .catch((error) => abort.abort(error));
  }, 10000);
  heartbeat.unref();
  let stopped = false;
  try {
    let revision = original.homeRevision;
    if (original.providerRef) {
      const ref = toComputerRef(original);
      if (original.kind === "docker") {
        await source.stop(ref, ctx);
        stopped = true;
        revision = await checkpointComputerWorkspace(home, source, original, ref, ctx);
      } else {
        if (!["stopped", "suspended"].includes(original.state)) {
          revision = await checkpointComputerWorkspace(home, source, original, ref, ctx);
        }
        await source.stop(ref, ctx);
        stopped = true;
      }
    }
    ctx.signal.throwIfAborted();
    const changed = await prisma.computer.updateMany({
      where: {
        id: computerId,
        maintenanceId: marker,
        homeMoveExpiresAt: { gt: new Date() },
        homeStorage: "snapshot",
        kind: original.kind,
        providerRef: original.providerRef,
      },
      data: {
        kind: "e2b",
        state: "stopped",
        providerRef: null,
        screenUrl: null,
        homeRevision: revision,
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
        maintenanceId: null,
        homeMoveExpiresAt: null,
      },
    });
    if (changed.count !== 1)
      throw new Error("Home preparation lost ownership; source snapshot was retained");
  } finally {
    clearInterval(heartbeat);
    await renewing;
    await prisma.computer.updateMany({
      where: { id: computerId, maintenanceId: marker },
      data: {
        maintenanceId: null,
        homeMoveExpiresAt: null,
        ...(stopped ? { state: "suspended" } : {}),
      },
    });
  }
}
