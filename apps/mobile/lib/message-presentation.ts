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

export type MessagePresentationSegment = {
  kind: "content";
  blocks: MessageBlock[];
};

export function messagePresentationSegments(
  blocks: readonly MessageBlock[],
): MessagePresentationSegment[] {
  const content = blocks.filter(
    (block) => block.kind !== "app_connect" && !isToolActivityBlock(block),
  );
  return content.length > 0 ? [{ kind: "content", blocks: content }] : [];
}

export function hasVisibleMessagePresentation(
  blocks: readonly MessageBlock[],
  showSteps = false,
): boolean {
  return visibleMessageBlocks(blocks, showSteps).length > 0;
}

export function stepsBlocks(
  blocks: readonly MessageBlock[],
): Extract<MessageBlock, { kind: "steps" }>[] {
  return blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "steps" }> => block.kind === "steps",
  );
}

/**
 * Where a skill line opens: the skill's own screen, found by its uid when the line has one, else
 * by its id. One the catalog no longer has opens Skills.
 */
export async function skillLineRoute(
  line: Pick<SkillSourceBlock, "skillUid" | "skillId">,
  catalog: () => Promise<ReadonlyArray<{ id: string; uid?: string }>>,
) {
  const skillId = (await catalog()).find((entry) =>
    line.skillUid ? entry.uid === line.skillUid : entry.id === line.skillId,
  )?.id;
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
