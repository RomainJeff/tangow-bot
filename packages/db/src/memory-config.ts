import type { PrismaClient } from "./client.js";

export function findSpaceMemoryConfig(
  prisma: Pick<PrismaClient, "spaceMemoryConfig">,
  spaceId: string,
) {
  return prisma.spaceMemoryConfig.findUnique({ where: { spaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}

export function findSpaceDecisionConfig(
  prisma: Pick<PrismaClient, "spaceDecisionConfig">,
  spaceId: string,
) {
  return prisma.spaceDecisionConfig.findUnique({ where: { spaceId } });
}
