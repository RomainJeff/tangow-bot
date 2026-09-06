import type { MessageBlock } from "@rakazo/contracts";

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/** The tool activity line a run is on right now — `Reading src/app.ts`,
    `Running: pnpm test` — for the working-state label. Undefined when the run
    is between tools, or when it is narrating text the transcript already shows.
    Activity blocks are hidden from the transcript, so this is the only place
    that line is read. */
export function latestActivityLabel(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.id.startsWith("progress:")) continue;
    const tail = message.blocks.at(-1);
    if (tail?.kind !== "progress" || tail.activity !== true) return undefined;
    return tail.text.trim() === "" ? undefined : tail.text.trim();
  }
  return undefined;
}
