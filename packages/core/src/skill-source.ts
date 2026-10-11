import type { MessageBlock } from "@rakazo/contracts";

export type SkillSourceBlock = Extract<MessageBlock, { kind: "skill_source" }>;

/** The skills a bot learned, updated or deleted in the exchange this message ends, in order. */
export function skillSourcesOf(blocks: readonly MessageBlock[]): SkillSourceBlock[] {
  return blocks.filter((block): block is SkillSourceBlock => block.kind === "skill_source");
}
