import type { ComputerMode } from "@tangow/contracts";
import type { Prisma, PrismaClient } from "./client.js";

export type { ComputerMode } from "@tangow/contracts";

export function parseComputerMode(scope: string): ComputerMode {
  if (scope === "team" || scope === "dedicated") return scope;
  throw new Error(`Unknown computer scope: ${scope}`);
}

export function computerScopeKey(
  mode: ComputerMode,
  spaceId: string,
  userId: string,
  botId?: string,
) {
  if (mode === "team") return `team:${spaceId}:${userId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return dedicatedComputerScopeKey(botId);
}

export function dedicatedComputerScopeKey(botId: string) {
  return `bot:${botId}`;
}

/** Written once at row creation, so legacy team homes keep `team-<spaceId>`. */
export function computerHomeKey(
  mode: ComputerMode,
  spaceId: string,
  userId: string,
  botId?: string,
) {
  if (mode === "team") return `team-${spaceId}-${userId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return botId;
}

type ComputerDb = Pick<PrismaClient, "computer">;
type ExecutionLeaseDb = Pick<PrismaClient, "computerExecutionLease">;

/** Expire leases as fencing tombstones so the next acquire increments fence. */
export async function expireComputerExecutionLeases(
  prisma: ExecutionLeaseDb,
  where: Prisma.ComputerExecutionLeaseWhereInput,
): Promise<void> {
  await prisma.computerExecutionLease.updateMany({
    where,
    data: { expiresAt: new Date(0) },
  });
}

export async function ensureComputerRecord(
  prisma: ComputerDb,
  input: {
    mode: ComputerMode;
    spaceId: string;
    userId: string;
    botId?: string;
    kind: string;
    /** Written only when the row is created. */
    homeStorage: string;
  },
) {
  const scopeKey = computerScopeKey(input.mode, input.spaceId, input.userId, input.botId);
  return prisma.computer.upsert({
    where: { scopeKey },
    create: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: input.mode,
      scopeKey,
      homeKey: computerHomeKey(input.mode, input.spaceId, input.userId, input.botId),
      kind: input.kind,
      homeStorage: input.homeStorage,
    },
    update: {},
  });
}
