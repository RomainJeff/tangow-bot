import { createHash } from "node:crypto";
import type { WorkerSkill } from "@rakazo/adapter-kit";
import { containsSecret, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Reports are observations by an untrusted guest. Reject secrets instead of storing masked skills. */
export async function indexWorkerSkills(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string; botId: string; runId: string; fence: number },
  skills: readonly WorkerSkill[],
  sources: readonly WorkerSkill["source"][],
  secrets: readonly string[],
): Promise<void> {
  const clean = skills.filter((skill) => {
    const parsed = parseSkillMd(skill.content);
    if (
      "error" in parsed ||
      parsed.name !== skill.name ||
      parsed.description !== skill.description ||
      createHash("sha256").update(skill.content).digest("hex") !== skill.contentHash
    )
      return false;
    const secret = [
      skill.name,
      skill.description,
      skill.path,
      skill.content,
      ...skill.files.flatMap((file) => [file.path, file.content]),
    ].some((text) => containsSecret(text, [...secrets]));
    if (secret) getLogger().warn("skills.index_refused", { botId: owner.botId, reason: "secret" });
    return !secret;
  });
  await prisma.$transaction(async (tx) => {
    if (sources.includes("shared")) {
      await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${owner.spaceId} FOR UPDATE`;
    }
    // Same run lock as cancellation and completion. A stale report never replaces the index.
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${owner.runId} FOR UPDATE`;
    const held = await tx.run.findFirst({
      where: {
        id: owner.runId,
        botId: owner.botId,
        spaceId: owner.spaceId,
        leaseFence: owner.fence,
        leaseExpiresAt: { gt: new Date() },
        status: { in: ["leased", "running"] },
      },
    });
    if (!held) return;
    await tx.volumeSkill.deleteMany({
      where: {
        OR: [
          { botId: owner.botId, source: { in: [...sources] } },
          ...(sources.includes("shared")
            ? [{ source: "shared", bot: { spaceId: owner.spaceId } }]
            : []),
        ],
      },
    });
    await tx.volumeSkill.createMany({
      data: clean.map(({ files: _, ...skill }) => ({ ...skill, botId: owner.botId })),
      skipDuplicates: true,
    });
  });
}
