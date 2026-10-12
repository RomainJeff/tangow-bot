import type { MessageBlock } from "@rakazo/contracts";
import type { NarrationSegment, SkillSourceBlock } from "@rakazo/core";
import { isToolActivityBlock, narrationSegments } from "@rakazo/core";

/**
 * The blocks the thread is about to draw: tool activity is hidden, except the
 * `steps` the "Display agent steps" setting asks for. Mirrors the web `isHiddenActivityBlock`;
 * the thread passes the result to `isAsideOnlyMessage` so a hidden block cannot change how a
 * message reads.
 */
export function visibleMessageBlocks(
  blocks: readonly MessageBlock[],
  showSteps = false,
): MessageBlock[] {
  return blocks.filter(
    (block) => !isToolActivityBlock(block) || (showSteps && block.kind === "steps"),
  );
}

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
  showSteps = false,
): NarrationSegment<MessageBlock>[] {
  return narrationSegments(
    blocks.filter((block) => block.kind === "steps" || !isToolActivityBlock(block)),
    (block) => (block.kind === "app_connect" ? undefined : block),
    showSteps,
  );
}

export function hasVisibleMessagePresentation(
  blocks: readonly MessageBlock[],
  showSteps = false,
): boolean {
  return visibleMessageBlocks(blocks, showSteps).length > 0;
}

/**
 * Where a skill line opens: the skill's own screen, found by its id. One the catalog no longer
 * has opens Skills.
 */
export async function skillLineRoute(
  line: Pick<SkillSourceBlock, "skillId">,
  catalog: () => Promise<ReadonlyArray<{ id: string }>>,
) {
  const skillId = (await catalog()).find((entry) => entry.id === line.skillId)?.id;
  return skillId
    ? ({ pathname: "/bot-skill", params: { skillId } } as const)
    : ({ pathname: "/skills" } as const);
}

/**
 * The segment whose bubble the skill lines hang under, given the text each segment draws: the last
 * one that draws any. -1 when none does, and the lines stand alone. Mirrors web's `skillLineBubble`.
 */
export function skillLineSegment(segmentTexts: readonly string[]): number {
  return segmentTexts.findLastIndex((text) => text !== "");
}
