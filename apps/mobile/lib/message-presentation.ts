import type { MessageBlock, ThreadItem } from "@tangow/contracts";
import type { NarrationSegment, SkillSourceBlock } from "@tangow/core";
import { isToolActivityBlock, narrationSegments } from "@tangow/core";
import { t } from "./i18n";

/**
 * The blocks the thread is about to draw: tool activity is hidden, except the
 * `steps` debug mode asks for. Mirrors the web `isHiddenActivityBlock`;
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

/**
 * The line a memory note draws: a run saved for everyone a shared bot is shared with, which every
 * other person's runs will read. A save to one's own memory draws nothing, as before.
 */
export function memoryNoteLine(item: Extract<ThreadItem, { kind: "note" }>): string | null {
  return item.type === "memory.revised" && item.payload.team ? t("Saved for the team") : null;
}
