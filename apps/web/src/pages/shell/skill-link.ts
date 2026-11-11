import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import type { SkillSourceBlock } from "@tangow/core";
import type { BotPageView } from "./layout";

/**
 * Where a skill line leads: the skill in the bot page's Knowledge tab, found by its id, or that
 * tab's list when the catalog no longer has it.
 */
export async function skillPageView(
  skill: Pick<SkillSourceBlock, "skillId">,
  catalog: () => Promise<ReadonlyArray<Pick<AgentSkillCatalogEntry, "id">>>,
): Promise<BotPageView> {
  const entry = (await catalog()).find((candidate) => candidate.id === skill.skillId);
  return { tab: "knowledge", detail: entry ? { kind: "skill", skillId: entry.id } : null };
}
