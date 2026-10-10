import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import type { BotPageView } from "./layout";

/**
 * Where a skill line leads: the skill in the bot page's Knowledge tab, found by its uid so a rename
 * since the line still opens it, or that tab's list when the line says it was deleted or the
 * catalog no longer has it.
 */
export async function skillPageView(
  skill: Pick<SkillSourceBlock, "skillUid" | "change">,
  catalog: () => Promise<ReadonlyArray<Pick<AgentSkillCatalogEntry, "id" | "uid">>>,
): Promise<BotPageView> {
  const entry =
    skill.change === "deleted"
      ? undefined
      : (await catalog()).find((candidate) => candidate.uid === skill.skillUid);
  return { tab: "knowledge", detail: entry ? { kind: "skill", skillId: entry.id } : null };
}
