import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import type { BotPageView } from "./layout";

/**
 * Where a skill line leads: the skill in the bot page's Knowledge tab, found by its uid so a rename
 * since the line still opens it. A deleted skill opens that tab's list with Recently deleted
 * expanded, and one the catalog no longer has, the list.
 */
export async function skillPageView(
  skill: Pick<SkillSourceBlock, "skillUid" | "change">,
  catalog: () => Promise<ReadonlyArray<Pick<AgentSkillCatalogEntry, "id" | "uid">>>,
): Promise<BotPageView> {
  if (skill.change === "deleted") return { tab: "knowledge", detail: null, trash: true };
  const entry = (await catalog()).find((candidate) => candidate.uid === skill.skillUid);
  return { tab: "knowledge", detail: entry ? { kind: "skill", skillId: entry.id } : null };
}
