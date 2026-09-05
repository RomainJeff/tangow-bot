import { userSkillsRoot, writeUserSkill } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

/**
 * Skills v2 phase 2: one-shot DB→FS export of legacy `agent_skills` rows. Runs at API boot,
 * idempotent (each row is deleted once written). "replace" so a crash between write and
 * delete just rewrites the same file next boot. The table itself is dropped in phase 3:
 * `prisma migrate deploy` runs before the app boots in compose, so dropping it in the same
 * release as the export would lose the rows.
 */
export async function exportLegacyAgentSkills(
  prisma: PrismaClient,
  dataDir: string,
): Promise<number> {
  const rows = await prisma.agentSkill.findMany();
  for (const row of rows) {
    await writeUserSkill(
      userSkillsRoot(dataDir, row),
      { name: row.name, content: row.content },
      "replace",
    );
    await prisma.agentSkill.delete({ where: { id: row.id } });
  }
  return rows.length;
}
