import type { MessageBlock } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import { isToolActivityBlock } from "@rakazo/core";

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

export type MessagePresentationSegment =
  | { kind: "content"; blocks: MessageBlock[] }
  | { kind: "steps"; block: Extract<MessageBlock, { kind: "steps" }> };

/**
 * What a message draws, in the order the bot produced it: each run of content is one segment, and
 * a `steps` block the setting shows stays where it is. Mirrors web's narration bubbles.
 */
export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
  showSteps = false,
): MessagePresentationSegment[] {
  const segments: MessagePresentationSegment[] = [];
  for (const block of blocks) {
    if (showSteps && block.kind === "steps") {
      segments.push({ kind: "steps", block });
      continue;
    }
    if (block.kind === "app_connect" || isToolActivityBlock(block)) continue;
    const last = segments.at(-1);
    if (last?.kind === "content") last.blocks.push(block);
    else segments.push({ kind: "content", blocks: [block] });
  }
  return segments;
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
