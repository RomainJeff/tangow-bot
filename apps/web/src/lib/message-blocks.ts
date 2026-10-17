import type { MessageBlock } from "@rakazo/contracts";
import { isLinkPreviewCard } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

/** Like isToolActivityBlock, but keeps `steps` visible when the pref is on. */
export function isHiddenActivityBlock(block: MessageBlock, showSteps: boolean): boolean {
  return isToolActivityBlock(block) && !(showSteps && block.kind === "steps");
}

/** Kinds that draw nothing of their own; a `link_mention` is drawn inside its message's text. */
const UNRENDERED_BLOCK_KINDS = new Set<MessageBlock["kind"]>([
  "link_mention",
  "connect",
  "reasoning",
  "routine_run",
]);

/**
 * Is there anything left to draw once hidden and undrawable blocks are out? A `link_preview`
 * block draws only as a card: the removal marker leaves no trace on screen.
 */
export function hasRenderableBlock(blocks: readonly MessageBlock[], showSteps: boolean): boolean {
  return blocks.some(
    (block) =>
      !isHiddenActivityBlock(block, showSteps) &&
      !UNRENDERED_BLOCK_KINDS.has(block.kind) &&
      (block.kind !== "link_preview" || isLinkPreviewCard(block)),
  );
}
