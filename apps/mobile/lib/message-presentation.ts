import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock, type SkillSourceBlock } from "@rakazo/core";

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
 * Where a skill line opens on iPhone: the Skills screen, where the owner manages the skills
 * every bot reads.
 */
export function skillLineRoute(_line: Pick<SkillSourceBlock, "change" | "skillUid">) {
  return { pathname: "/skills" } as const;
}
