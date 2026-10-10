import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import type { BotPageView } from "./layout";

/**
 * Where a skill line leads: the skill in the bot page's Knowledge tab, found by its uid when the
 * line has one, else by its id, or that tab's list when the catalog no longer has it.
 */
export async function skillPageView(
  skill: Pick<SkillSourceBlock, "skillUid" | "skillId">,
  catalog: () => Promise<ReadonlyArray<Pick<AgentSkillCatalogEntry, "id" | "uid">>>,
): Promise<BotPageView> {
  const entry = (await catalog()).find((candidate) =>
    skill.skillUid ? candidate.uid === skill.skillUid : candidate.id === skill.skillId,
  );
  return { tab: "knowledge", detail: entry ? { kind: "skill", skillId: entry.id } : null };
}
